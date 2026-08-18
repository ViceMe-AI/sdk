import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const NORMALIZED_MTIME = new Date('2000-01-01T00:00:00.000Z');

function walk(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const path = relative(root, absolute).split('\\').join('/');
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      entries.push(...walk(root, absolute));
    } else {
      entries.push({ absolute, path, stat });
    }
  }
  return entries;
}

export function createDeterministicZip(sourceDir, archivePath) {
  const stage = mkdtempSync(join(tmpdir(), 'viceme-release-zip-'));
  try {
    cpSync(sourceDir, stage, { recursive: true, preserveTimestamps: false });
    const files = walk(stage);
    if (files.length === 0) {
      throw new Error('release zip source is empty');
    }
    for (const { absolute } of files) {
      utimesSync(absolute, NORMALIZED_MTIME, NORMALIZED_MTIME);
    }
    rmSync(archivePath, { force: true });
    execFileSync('zip', ['-X', '-q', archivePath, ...files.map(({ path }) => path)], {
      cwd: stage,
      env: { ...process.env, TZ: 'UTC' },
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function snapshotTree(root) {
  return walk(root).map(({ absolute, path, stat }) => {
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      return { path, type: 'symlink', mode, target: readlinkSync(absolute) };
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported release asset entry: ${path}`);
    }
    return {
      path,
      type: 'file',
      mode,
      digest: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
    };
  });
}

export function zipContentsEqual(archivePath, expectedDir) {
  const extracted = mkdtempSync(join(tmpdir(), 'viceme-release-zip-compare-'));
  try {
    execFileSync('unzip', ['-q', archivePath, '-d', extracted]);
    return JSON.stringify(snapshotTree(extracted)) === JSON.stringify(snapshotTree(expectedDir));
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}
