#!/usr/bin/env node
/**
 * Size budget gate (B0 initial values, gzip bytes).
 *
 * These are CI gates, not product promises; adjustments must justify which
 * public capability added the bytes.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'packages', 'sdk', 'dist');

const BUDGETS = {
  'index.js': { gzip: 15 * 1024, label: 'core ESM' },
  'viceme.min.js': { gzip: 12 * 1024, label: 'CDN loader with creator access' },
  'testing.js': { gzip: 12 * 1024, label: 'testing adapter' },
  'danmaku.js': { gzip: 16 * 1024, label: 'hosted danmaku capability' },
};

const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));

let failed = false;
for (const [file, budget] of Object.entries(BUDGETS)) {
  const info = manifest.files[file];
  if (!info) {
    console.error(`size budget: ${file} (${budget.label}) missing from manifest`);
    failed = true;
    continue;
  }
  const over = info.gzipBytes - budget.gzip;
  const pct = ((info.gzipBytes / budget.gzip) * 100).toFixed(1);
  if (over > 0) {
    console.error(
      `size budget EXCEEDED: ${file} (${budget.label}) gzip ${info.gzipBytes}B > ${budget.gzip}B`,
    );
    failed = true;
  } else {
    console.log(
      `size budget ok: ${file} (${budget.label}) gzip ${info.gzipBytes}B / ${budget.gzip}B (${pct}%)`,
    );
  }
}

if (failed) process.exit(1);
