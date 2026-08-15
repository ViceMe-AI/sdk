#!/usr/bin/env node
/**
 * Cross-platform actionlint runner (v1.7.7, digest-pinned).
 *
 * Downloads the exact release for the current platform (process.platform /
 * process.arch — including Windows zips), verifies the sha256 from the
 * official checksums, caches the binary, and runs it over the repo's
 * workflows. External linters are disabled so results depend only on
 * actionlint itself.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.7.7';
const TARGETS = {
  'darwin/arm64': {
    file: 'darwin_arm64.tar.gz',
    sha256: '2693315b9093aeacb4ebd91a993fea54fc215057bf0da2659056b4bc033873db',
  },
  'darwin/x64': {
    file: 'darwin_amd64.tar.gz',
    sha256: '28e5de5a05fc558474f638323d736d822fff183d2d492f0aecb2b73cc44584f5',
  },
  'linux/x64': {
    file: 'linux_amd64.tar.gz',
    sha256: '023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757',
  },
  'linux/arm64': {
    file: 'linux_arm64.tar.gz',
    sha256: '401942f9c24ed71e4fe71b76c7d638f66d8633575c4016efd2977ce7c28317d0',
  },
  'win32/x64': {
    file: 'windows_amd64.zip',
    sha256: '7f12f1801bca3d480d67aaf7774f4c2a6359a3ca8eebe382c95c10c9704aa731',
  },
  'win32/arm64': {
    file: 'windows_arm64.zip',
    sha256: '76e9514cfac18e5677aa04f3a89873c981f16a2f2353bb97372a86cd09b1f5a8',
  },
};

const key = `${process.platform}/${process.arch}`;
const target = TARGETS[key];
if (!target) {
  console.error(`run-actionlint: unsupported platform ${key}`);
  process.exit(1);
}

const cacheDir = join(tmpdir(), `viceme-actionlint-${VERSION}`);
const binary = join(cacheDir, process.platform === 'win32' ? 'actionlint.exe' : 'actionlint');

if (!existsSync(binary)) {
  mkdirSync(cacheDir, { recursive: true });
  const url = `https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_${target.file}`;
  const archive = join(cacheDir, target.file);
  const download = spawnSync('curl', ['-fsSL', '-o', archive, url], { stdio: 'inherit' });
  if (download.status !== 0) {
    console.error('run-actionlint: download failed');
    process.exit(1);
  }
  const { readFile } = await import('node:fs/promises');
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  if (digest !== target.sha256) {
    console.error(`run-actionlint: digest mismatch for ${target.file}: ${digest}`);
    rmSync(archive, { force: true });
    process.exit(1);
  }
  if (target.file.endsWith('.zip')) {
    // Windows: expand-archive writes actionlint.exe into the cache dir.
    const expand = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Force -Path "${archive}" -DestinationPath "${cacheDir}"`,
      ],
      { stdio: 'inherit' },
    );
    if (expand.status !== 0) {
      console.error('run-actionlint: unzip failed');
      process.exit(1);
    }
  } else {
    const extract = spawnSync(
      'tar',
      [
        '-xzf',
        archive,
        '-C',
        cacheDir,
        process.platform === 'win32' ? 'actionlint.exe' : 'actionlint',
      ],
      { stdio: 'inherit' },
    );
    if (extract.status !== 0) {
      console.error('run-actionlint: extract failed');
      process.exit(1);
    }
  }
  chmodSync(binary, 0o755);
}

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(binary, ['-color', '-shellcheck=', '-pyflakes='], {
  cwd: join(here, '..'),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
