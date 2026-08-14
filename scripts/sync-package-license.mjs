#!/usr/bin/env node
/**
 * Sync the repo-root LICENSE into the publishable package directory.
 *
 * `@viceme-ai/sdk` packs from packages/sdk, so the LICENSE must exist THERE
 * to ship in the tarball. The root file is the single source of truth; the
 * package copy is generated at build time (gitignored) so it can never drift.
 *
 * While the license is still pending (root LICENSE absent), any stale package
 * copy is removed so a tarball can never ship an outdated or placeholder
 * license silently.
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'LICENSE');
const target = join(root, 'packages', 'sdk', 'LICENSE');

if (existsSync(source)) {
  copyFileSync(source, target);
  console.log('package license synced from repo root');
} else if (existsSync(target)) {
  rmSync(target);
  console.log('no root LICENSE; removed stale packages/sdk/LICENSE');
} else {
  console.log('license still pending; packages/sdk/LICENSE not created');
}
