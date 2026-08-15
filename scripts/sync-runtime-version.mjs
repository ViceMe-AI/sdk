#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const packagePath = join(root, 'packages', 'sdk', 'package.json');
const runtimeVersionPath = join(root, 'packages', 'sdk', 'src', 'version.ts');
const versionPattern = /export const SDK_VERSION = '([^']+)';/g;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function syncRuntimeVersion({
  packageFile = packagePath,
  runtimeVersionFile = runtimeVersionPath,
} = {}) {
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
  const version = packageJson.version;
  if (typeof version !== 'string' || !semverPattern.test(version)) {
    throw new Error(`package.json contains an invalid release version: ${String(version)}`);
  }

  const source = readFileSync(runtimeVersionFile, 'utf8');
  const matches = [...source.matchAll(versionPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one SDK_VERSION declaration in ${runtimeVersionFile}, found ${matches.length}`,
    );
  }

  const next = source.replace(versionPattern, `export const SDK_VERSION = '${version}';`);
  if (next !== source) writeFileSync(runtimeVersionFile, next);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = syncRuntimeVersion();
  console.log(`runtime SDK_VERSION synchronized to ${version}`);
}
