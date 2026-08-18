#!/usr/bin/env node
/**
 * Prepare the ephemeral POC package identity inside a release runner.
 *
 * The source repository deliberately remains @viceme-ai/sdk so workspace
 * filters, examples, and the formal release chain keep one canonical name.
 * The manual POC workflow invokes this only after the immutable source SHA
 * has passed quality gates.
 */
import { readFile, writeFile } from 'node:fs/promises';

const packageUrl = new URL('../packages/sdk/package.json', import.meta.url);
const versionUrl = new URL('../packages/sdk/src/version.ts', import.meta.url);
const POC_PACKAGE = '@viceme-ai/sdk-poc';
const POC_VERSION = /^\d+\.\d+\.\d+-poc\.\d+$/;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') args.version = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.version || !POC_VERSION.test(args.version)) {
  console.error('usage: prepare-poc-package.mjs --version <x.y.z-poc.N>');
  process.exit(2);
}

const packageDocument = JSON.parse(await readFile(packageUrl, 'utf8'));
if (packageDocument.name !== '@viceme-ai/sdk') {
  throw new Error(`expected source package @viceme-ai/sdk, got ${packageDocument.name}`);
}
packageDocument.name = POC_PACKAGE;
packageDocument.version = args.version;
await writeFile(packageUrl, `${JSON.stringify(packageDocument, null, 2)}\n`);

const versionSource = await readFile(versionUrl, 'utf8');
const updatedVersionSource = versionSource.replace(
  /export const SDK_VERSION = '[^']+';/,
  `export const SDK_VERSION = '${args.version}';`,
);
if (updatedVersionSource === versionSource) {
  throw new Error('could not replace SDK_VERSION in packages/sdk/src/version.ts');
}
await writeFile(versionUrl, updatedVersionSource);

console.log(`prepared ${POC_PACKAGE}@${args.version}`);
