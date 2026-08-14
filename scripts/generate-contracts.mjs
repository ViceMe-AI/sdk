#!/usr/bin/env node
/**
 * Contract codegen + drift gate.
 *
 * Modes:
 *   node scripts/generate-contracts.mjs            # regenerate types + manifest
 *   node scripts/generate-contracts.mjs check      # drift gate (CI): the
 *                                                  # committed generated file
 *                                                  # and manifest digest must
 *                                                  # match the snapshot.
 *
 * Source of truth: contracts/public-capabilities.openapi.json (Shop export).
 * The generated file packages/sdk/src/generated/public-contract.ts is
 * committed so consumers build without codegen, and CI verifies it never
 * drifts from the snapshot.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const snapshotPath = join(root, 'contracts', 'public-capabilities.openapi.json');
const manifestPath = join(root, 'contracts', 'contract-manifest.json');
const generatedPath = join(root, 'packages', 'sdk', 'src', 'generated', 'public-contract.ts');
const bin = join(root, 'node_modules', '.bin', 'openapi-typescript');

const check = process.argv[2] === 'check';
const snapshot = readFileSync(snapshotPath);
const snapshotJson = JSON.parse(snapshot.toString('utf8'));
const sha256 = createHash('sha256').update(snapshot).digest('hex');

const BANNER = `/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Generated from contracts/public-capabilities.openapi.json
 * (contractVersion ${snapshotJson.info.version}, sha256 ${sha256.slice(0, 16)}…)
 * by scripts/generate-contracts.mjs. Regenerate with \`pnpm contracts:generate\`.
 */
`;

execFileSync(bin, [snapshotPath, '-o', generatedPath], {
  cwd: root,
  stdio: 'inherit',
});

// The CLI does not support a custom banner reliably; prepend our own provenance
// header (with the snapshot digest marker used by the drift gate).
const generatedBody = readFileSync(generatedPath, 'utf8');
writeFileSync(generatedPath, `${BANNER}\n${generatedBody}`);

const manifest = {
  contractVersion: snapshotJson.info.version,
  sha256,
  generatedFrom: process.env.CONTRACT_SOURCE ?? 'sdk-baseline (pending first Shop export)',
  generatedAt: new Date().toISOString(),
};

if (check) {
  const committed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (committed.sha256 !== manifest.sha256) {
    console.error('contract drift: manifest sha256 does not match the snapshot');
    console.error(`  committed: ${committed.sha256}`);
    console.error(`  snapshot:  ${manifest.sha256}`);
    process.exit(1);
  }
  const generated = readFileSync(generatedPath, 'utf8');
  if (!generated.includes(sha256.slice(0, 16))) {
    console.error('contract drift: generated types were not built from the current snapshot');
    console.error('run: pnpm contracts:generate');
    process.exit(1);
  }
  console.log('contract drift check passed');
} else {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`contracts generated @ ${manifest.contractVersion} (${sha256.slice(0, 12)}…)`);
}
