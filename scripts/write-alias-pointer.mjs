#!/usr/bin/env node
/**
 * Atomic stable-alias pointer writer.
 *
 * Moves the `/sdk/v1` stable alias by writing ONE pointer object per region
 * (`sdk/-/aliases/v1`, body = exactly the version string) through the
 * region-scoped upload contract, then reads the pointer back over HTTP and
 * requires an exact match. No files are ever copied under `/sdk/v1`; the CDN
 * edge resolves `/sdk/v1/<file>` from the pointer (see docs/RELEASE.md).
 *
 * Usage:
 *   node scripts/write-alias-pointer.mjs --version 1.2.3 \
 *     --regions cn,global \
 *     --hosts cn=https://cdn.viceme.cn,global=https://cdn.viceme.ai \
 *     --upload-command "<cmd invoked as: cmd <region> <local-file> <object-key>>" \
 *     [--pointer-key sdk/-/aliases/v1]
 *
 * Exit 1 on any unknown region, missing host mapping, upload failure, or
 * read-back mismatch — before the next region is touched.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_POINTER_KEY = 'sdk/-/aliases/v1';
const KNOWN_REGIONS = new Set(['cn', 'global']);

function parseArgs(argv) {
  const args = { pointerKey: DEFAULT_POINTER_KEY };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--regions') args.regions = argv[++i];
    else if (argv[i] === '--hosts') args.hosts = argv[++i];
    else if (argv[i] === '--upload-command') args.uploadCommand = argv[++i];
    else if (argv[i] === '--pointer-key') args.pointerKey = argv[++i];
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
if (!args.version || !args.regions || !args.hosts || !args.uploadCommand) {
  console.error(
    'usage: write-alias-pointer.mjs --version <v> --regions cn,global --hosts cn=<url>,global=<url> --upload-command <cmd>',
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
    execFileSync('bash', [
      '-lc',
      `${args.uploadCommand} ${region} ${pointerFile} ${args.pointerKey}`,
    ]);
    const host = hosts.get(region).replace(/\/+$/, '');
    const pointerUrl = `${host}/${args.pointerKey}`;
    const response = await fetch(pointerUrl, { credentials: 'omit' });
    if (!response.ok) {
      console.error(`pointer read-back failed: ${pointerUrl}: HTTP ${response.status}`);
      process.exit(1);
    }
    const got = (await response.text()).trim();
    if (got !== args.version) {
      console.error(
        `pointer mismatch for ${region}: read-back '${got}' != expected '${args.version}'`,
      );
      process.exit(1);
    }
    console.log(`alias pointer ${region}: ${pointerUrl} -> ${args.version}`);
  }
  console.log(`alias pointer written and verified in ${regions.length} region(s)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
