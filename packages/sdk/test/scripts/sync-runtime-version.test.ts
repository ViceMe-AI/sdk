// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncRuntimeVersion } from '../../../../scripts/sync-runtime-version.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(version: unknown, source = "export const SDK_VERSION = '0.1.0';\n") {
  const directory = mkdtempSync(join(tmpdir(), 'viceme-sdk-version-'));
  temporaryDirectories.push(directory);
  const packageFile = join(directory, 'package.json');
  const runtimeVersionFile = join(directory, 'src', 'version.ts');
  mkdirSync(join(directory, 'src'));
  writeFileSync(packageFile, `${JSON.stringify({ version }, null, 2)}\n`);
  writeFileSync(runtimeVersionFile, source);
  return { packageFile, runtimeVersionFile };
}

describe('syncRuntimeVersion', () => {
  it('synchronizes stable and prerelease package versions', () => {
    const files = fixture('0.2.0-next.0');
    expect(syncRuntimeVersion(files)).toBe('0.2.0-next.0');
    expect(readFileSync(files.runtimeVersionFile, 'utf8')).toBe(
      "export const SDK_VERSION = '0.2.0-next.0';\n",
    );
  });

  it('fails closed for invalid package versions', () => {
    const files = fixture('../not-a-version');
    expect(() => syncRuntimeVersion(files)).toThrow('invalid release version');
  });

  it('fails closed when the runtime declaration is missing or ambiguous', () => {
    const missing = fixture('1.0.0', 'export const API_MAJOR = 1;\n');
    expect(() => syncRuntimeVersion(missing)).toThrow('found 0');

    const duplicate = fixture(
      '1.0.0',
      "export const SDK_VERSION = '0.1.0';\nexport const SDK_VERSION = '0.1.0';\n",
    );
    expect(() => syncRuntimeVersion(duplicate)).toThrow('found 2');
  });
});
