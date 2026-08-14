#!/usr/bin/env node
/**
 * Atomic stable-alias pointer writer with monotonic-forward / authorized
 * rollback semantics (review P1: a stale rerun must never pull `/sdk/v1`
 * backward, and rollback must be an explicit, preconditions-checked
 * operation).
 *
 * Modes:
 *   --mode promote (default): read the current pointer first; the move is
 *     allowed only when the target is strictly newer (or the pointer is
 *     unset). Refuses to move backward or to the same version.
 *   --mode rollback: requires --from-current <version>; the live pointer
 *     must equal that exact value (stale/concurrent-move guard) and the
 *     target must be older. This is the only path allowed to go backward.
 *
 * Convergence model: the public pointer URL is cacheable (short TTL), so
 * `--purge-command` (optional, `purge <region> <key>`) runs right after the
 * write, and the pointer is then polled with a bounded budget
 * (`--converge-timeout-ms`, default 330s > the 300s TTL); on timeout the
 * failure reports the last observed value (stale edge vs origin problem).
 *
 * Usage:
 *   node scripts/write-alias-pointer.mjs --version 1.2.3 \
 *     --regions cn,global \
 *     --hosts cn=https://cdn.viceme.cn,global=https://cdn.viceme.ai \
 *     --upload-command "<cmd invoked as: cmd <region> <local-file> <object-key>>" \
 *     [--mode promote|rollback] [--from-current 1.2.2] \
 *     [--purge-command "<cmd invoked as: cmd <region> <object-key>>"] \
 *     [--pointer-key sdk/-/aliases/v1] [--converge-timeout-ms 330000]
 *
 * Exit 1 on any unknown region, missing host mapping, upload failure,
 * policy refusal, or non-convergence — before the next region is touched.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { decideMutableTagMove } from './lib/release-policy.mjs';

const DEFAULT_POINTER_KEY = 'sdk/-/aliases/v1';
const DEFAULT_CONVERGE_TIMEOUT_MS = 330_000;
const POLL_INTERVAL_MS = 3_000;
const KNOWN_REGIONS = new Set(['cn', 'global']);

function parseArgs(argv) {
  const args = {
    pointerKey: DEFAULT_POINTER_KEY,
    convergeTimeoutMs: DEFAULT_CONVERGE_TIMEOUT_MS,
    mode: 'promote',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--regions') args.regions = argv[++i];
    else if (argv[i] === '--hosts') args.hosts = argv[++i];
    else if (argv[i] === '--upload-command') args.uploadCommand = argv[++i];
    else if (argv[i] === '--purge-command') args.purgeCommand = argv[++i];
    else if (argv[i] === '--pointer-key') args.pointerKey = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--from-current') args.fromCurrent = argv[++i];
    else if (argv[i] === '--converge-timeout-ms') {
      args.convergeTimeoutMs = Number(argv[++i]);
    }
  }
  return args;
}

function parseHosts(raw) {
  const hosts = new Map();
  for (const pair of raw.split(',')) {
    const [region, host] = pair.split('=');
    hosts.set(region, host);
  }
  return hosts;
}

const args = parseArgs(process.argv.slice(2));
if (
  !args.version ||
  !args.regions ||
  !args.hosts ||
  !args.uploadCommand ||
  !['promote', 'rollback'].includes(args.mode)
) {
  console.error(
    'usage: write-alias-pointer.mjs --version <v> --regions cn,global --hosts cn=<url>,global=<url> --upload-command <cmd> [--mode promote|rollback] [--from-current <v>] [--purge-command <cmd>]',
  );
  process.exit(2);
}

const hosts = parseHosts(args.hosts);
const regions = args.regions
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
for (const region of regions) {
  if (!KNOWN_REGIONS.has(region)) {
    console.error(`unknown region '${region}' (expected cn or global)`);
    process.exit(1);
  }
  if (!hosts.get(region)) {
    console.error(`no --hosts entry for region '${region}'`);
    process.exit(1);
  }
}

/** Best-effort single read of the current pointer (undefined when unset). */
async function readPointer(pointerUrl) {
  try {
    const response = await fetch(pointerUrl, {
      credentials: 'omit',
      headers: { 'cache-control': 'no-cache' },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) return undefined;
    const text = (await response.text()).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Poll the public pointer until it equals the version, within a budget. */
async function awaitPointerConvergence(pointerUrl, expected) {
  const deadline = Date.now() + args.convergeTimeoutMs;
  let lastObserved = '(no response)';
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(pointerUrl, {
        credentials: 'omit',
        headers: { 'cache-control': 'no-cache' },
      });
      lastStatus = response.status;
      if (response.ok) {
        lastObserved = (await response.text()).trim();
        if (lastObserved === expected) return;
      }
    } catch (error) {
      lastObserved = `(fetch error: ${String(error)})`;
    }
    await wait(POLL_INTERVAL_MS);
  }
  console.error(`pointer did not converge within ${args.convergeTimeoutMs}ms: ${pointerUrl}`);
  console.error(`  expected:   '${expected}'`);
  console.error(`  last seen:  '${lastObserved}' (HTTP ${lastStatus})`);
  console.error(
    '  A stale value usually means the CDN edge still serves the previous pointer within its TTL — configure CDN_PURGE_COMMAND, or wait for the TTL.',
  );
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'viceme-alias-'));
try {
  // The pointer body is exactly the version string — nothing else.
  const pointerFile = join(tmp, 'pointer-version');
  writeFileSync(pointerFile, args.version);

  for (const region of regions) {
    const host = hosts.get(region).replace(/\/+$/, '');
    const pointerUrl = `${host}/${args.pointerKey}`;

    // Policy check BEFORE any write: promote only moves forward; rollback
    // requires the live pointer to equal the explicitly declared current
    // value (stale/concurrent-move guard).
    const current = await readPointer(pointerUrl);
    const decision = decideMutableTagMove({
      mode: args.mode,
      current,
      target: args.version,
      expectedCurrent: args.fromCurrent,
    });
    if (!decision.allowed) {
      console.error(`alias policy refused for ${region}: ${decision.reason}`);
      process.exit(1);
    }
    console.log(`alias policy ${region}: ${decision.reason}`);

    execFileSync('bash', [
      '-lc',
      `${args.uploadCommand} ${region} ${pointerFile} ${args.pointerKey}`,
    ]);
    if (args.purgeCommand) {
      execFileSync('bash', ['-lc', `${args.purgeCommand} ${region} ${args.pointerKey}`]);
    }
    await awaitPointerConvergence(pointerUrl, args.version);
    console.log(`alias pointer ${region}: ${pointerUrl} -> ${args.version}`);
  }
  console.log(`alias pointer written and verified in ${regions.length} region(s)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
