import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeterministicZip, zipContentsEqual } from './release-zip.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'viceme-release-zip-test-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'nested'), { recursive: true });
  writeFileSync(join(dist, 'index.js'), 'export const value = 1;\n');
  writeFileSync(join(dist, 'nested', 'style.css'), 'body { color: black; }\n');
  return { root, dist };
}

test('deterministic release zip ignores source mtimes', () => {
  const { root, dist } = fixture();
  try {
    const first = join(root, 'first.zip');
    const second = join(root, 'second.zip');
    createDeterministicZip(dist, first);
    const later = new Date('2026-08-18T12:00:00.000Z');
    utimesSync(join(dist, 'index.js'), later, later);
    createDeterministicZip(dist, second);
    assert.deepEqual(readFileSync(first), readFileSync(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic comparison accepts container metadata changes and rejects content changes', () => {
  const { root, dist } = fixture();
  try {
    const archive = join(root, 'release.zip');
    createDeterministicZip(dist, archive);
    assert.equal(zipContentsEqual(archive, dist), true);
    writeFileSync(join(dist, 'index.js'), 'export const value = 2;\n');
    assert.equal(zipContentsEqual(archive, dist), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
