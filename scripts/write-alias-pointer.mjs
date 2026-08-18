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
 *     --hosts cn=https://s3.viceme.cn,global=https://s3.viceme.ai \
 *     --upload-command "<cmd invoked as: cmd <region> <local-file> <object-key>>" \
 *     [--mode promote|rollback] [--from-current 1.2.2] \
 *     [--purge-command "<cmd invoked as: cmd <region> <object-key>>"] \
 *     [--pointer-key -/aliases/v1] [--converge-timeout-ms 330000]
 *
 * Exit 1 on any unknown region, missing host mapping, upload failure,
 * policy refusal, or non-convergence — before the next region is touched.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitPointerConvergence, readPointerState } from './lib/pointer-client.mjs';
import { decideMutableTagMove } from './lib/release-policy.mjs';

const DEFAULT_POINTER_KEY = '-/aliases/v1';
const DEFAULT_CONVERGE_TIMEOUT_MS = 330_000;
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

const tmp = mkdtempSync(join(tmpdir(), 'viceme-alias-'));
try {
  // The pointer body is exactly the version string — nothing else.
  const pointerFile = join(tmp, 'pointer-version');
  writeFileSync(pointerFile, args.version);

  for (const region of regions) {
    const host = hosts.get(region).replace(/\/+$/, '');
    const pointerUrl = `${host}/${args.pointerKey}`;

    // Policy check BEFORE any write. The read is strict: only an explicit
    // 404 means "unset"; 403/5xx/timeouts/garbage fail closed so a stale
    // run can never overwrite a newer pointer during a read fault.
    const state = await readPointerState(pointerUrl);
    if (state.kind === 'error') {
      console.error(`pointer read failed for ${region}: ${state.detail} — failing closed`);
      process.exit(1);
    }
    const current = state.kind === 'value' ? state.value : undefined;
    const decision = decideMutableTagMove({
      mode: args.mode,
      current,
      target: args.version,
      expectedCurrent: args.fromCurrent,
    });
    if (!decision.allowed) {
      if (decision.converged) {
        // Partial-success rerun: this region already serves the target;
        // verify and continue with the remaining regions.
        await awaitPointerConvergence(pointerUrl, args.version, 2000, 500);
        console.log(`alias policy ${region}: ${decision.reason}`);
        continue;
      }
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
    await awaitPointerConvergence(pointerUrl, args.version, args.convergeTimeoutMs);
    console.log(`alias pointer ${region}: ${pointerUrl} -> ${args.version}`);
  }
  console.log(`alias pointer written and verified in ${regions.length} region(s)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
