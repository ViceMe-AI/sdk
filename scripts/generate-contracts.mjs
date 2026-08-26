#!/usr/bin/env node
/**
 * Contract codegen + drift gate.
 *
 * Modes:
 *   node scripts/generate-contracts.mjs            # regenerate types + manifest
 *   node scripts/generate-contracts.mjs check      # drift gate (CI)
 *
 * Source of truth: contracts/public-capabilities.openapi.json (Shop export).
 * The generated file packages/sdk/src/generated/public-contract.ts is
 * committed so consumers build without codegen.
 *
 * The gate is byte-exact and side-effect free: `check` generates into a
 * temporary file and compares it against the committed generated file (and
 * the committed manifest against the snapshot digest). It never writes to
 * the working tree — a green check therefore proves the committed artifacts
 * match the snapshot, and CI additionally asserts a clean `git diff`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Always generate into a temporary file first: generate mode moves the result
// into place; check mode only reads it for comparison.
const tmpDir = mkdtempSync(join(tmpdir(), 'viceme-contracts-'));
const tmpOut = join(tmpDir, 'public-contract.ts');
try {
  execFileSync(bin, [snapshotPath, '-o', tmpOut], { cwd: root, stdio: 'inherit' });
  // The CLI does not support a custom banner reliably; prepend our own
  // provenance header (with the snapshot digest marker used by the gate).
  const generated = `${BANNER}\n${readFileSync(tmpOut, 'utf8')}`;

  if (check) {
    let committed = null;
    try {
      committed = readFileSync(generatedPath, 'utf8');
    } catch {
      console.error('contract drift: generated types are missing from the repo');
      console.error('run: pnpm contracts:generate');
      process.exit(1);
    }
    if (committed !== generated) {
      console.error('contract drift: committed generated types differ from regeneration');
      console.error('run: pnpm contracts:generate');
      process.exit(1);
    }
    const committedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (committedManifest.sha256 !== sha256) {
      console.error('contract drift: manifest sha256 does not match the snapshot');
      console.error(`  committed: ${committedManifest.sha256}`);
      console.error(`  snapshot:  ${sha256}`);
      process.exit(1);
    }
    if (committedManifest.contractVersion !== snapshotJson.info.version) {
      console.error('contract drift: manifest contractVersion does not match the snapshot');
      process.exit(1);
    }
    console.log('contract drift check passed');
  } else {
    writeFileSync(generatedPath, generated);
    const manifest = {
      contractVersion: snapshotJson.info.version,
      sha256,
      generatedFrom: process.env.CONTRACT_SOURCE ?? 'ViceMe Shop public capabilities contract',
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`contracts generated @ ${manifest.contractVersion} (${sha256.slice(0, 12)}…)`);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
