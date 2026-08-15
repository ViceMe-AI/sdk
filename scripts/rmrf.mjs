#!/usr/bin/env node
/**
 * Minimal `rm -rf` for build scripts (cross-platform, no deps).
 * Usage: node rmrf.mjs <path> [<path> ...]
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('rmrf.mjs: no targets given');
  process.exit(1);
}
for (const target of targets) {
  rmSync(resolve(process.cwd(), target), { recursive: true, force: true });
}
