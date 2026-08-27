#!/usr/bin/env node
/**
 * Tarball audit for `@viceme-ai/sdk`.
 *
 * Runs a real `pnpm pack`, asserts the tarball contains only allowlisted
 * paths, then runs an import smoke test against the extracted tarball — not
 * workspace sources — so CI proves what npm consumers actually install.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApiMajor } from './lib/version-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sdkDir = join(root, 'packages', 'sdk');

const tmp = mkdtempSync(join(tmpdir(), 'viceme-tarball-'));
try {
  // 1. Pack from a clean copy of package state.
  execFileSync('pnpm', ['pack', '--pack-destination', tmp], {
    cwd: sdkDir,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const tarballName = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tarballName) throw new Error('pnpm pack produced no tarball');
  const tarball = join(tmp, tarballName);

  // 2. List entries.
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  const entries = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith('/'));

  const packageJsonEntry = entries.find((e) => e === 'package/package.json');
  if (!packageJsonEntry) throw new Error('tarball missing package.json');

  const ALLOWED = [
    /^package\/package\.json$/,
    /^package\/README\.md$/,
    /^package\/LICENSE(\..*)?$/,
    /^package\/dist\/.+$/,
  ];
  const FORBIDDEN = [
    /\/src\//,
    /\/test\//,
    /\/node_modules\//,
    // Source .ts files — but not emitted .d.ts declarations.
    /(?<!\.d)\.ts$/,
    /vite\.config/,
    /tsconfig/,
  ];

  const violations = entries.filter((entry) => {
    const allowed = ALLOWED.some((pattern) => pattern.test(entry));
    const forbidden = FORBIDDEN.some((pattern) => pattern.test(entry));
    return !allowed || forbidden;
  });
  if (violations.length > 0) {
    console.error('tarball audit failed for entries:');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  // 2b. Required entries. README always ships; once the final repo-root
  // LICENSE exists (build copies it into the package), the tarball MUST
  // carry it too — a missing license entry fails closed instead of
  // publishing an unlicensed artifact.
  const required = ['package/package.json', 'package/README.md'];
  if (existsSync(join(root, 'LICENSE'))) required.push('package/LICENSE');
  const missingEntries = required.filter((entry) => !entries.includes(entry));
  if (missingEntries.length > 0) {
    console.error('tarball audit failed; required entries missing:');
    for (const entry of missingEntries) console.error(`  ${entry}`);
    process.exit(1);
  }

  // 3. Extract and smoke-test the installed artifact.
  const extractDir = join(tmp, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir], { stdio: 'inherit' });
  const pkgDir = join(extractDir, 'package');

  const smoke = `
    const { createViceMe, ViceMeError, isViceMeError, SDK_VERSION } = await import(
      new URL('./dist/index.js', import.meta.url).href
    );
    const { mountDanmaku } = await import(
      new URL('./dist/danmaku.js', import.meta.url).href
    );
    const { mountTip } = await import(
      new URL('./dist/tip.js', import.meta.url).href
    );
    if (typeof createViceMe !== 'function') throw new Error('createViceMe missing');
    if (typeof mountDanmaku !== 'function') throw new Error('mountDanmaku missing');
    if (typeof mountTip !== 'function') throw new Error('mountTip missing');
    if (typeof ViceMeError !== 'function' || !isViceMeError(new ViceMeError({ code: 'INTERNAL_ERROR', message: 'x' }))) {
      throw new Error('error model missing');
    }
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error('unexpected network request');
    };
    const client = createViceMe({ workKey: 'wrk_test', region: 'cn' });
    if (client.state !== 'CREATED') throw new Error('unexpected initial state');
    await client.ready();
    if (networkCalls !== 0) throw new Error('local initialization reached the network');
    if (!client.hasCapability('danmaku') || !client.hasCapability('tip') || client.hasCapability('checkout')) {
      throw new Error('PUBLIC-only capability check broken');
    }
    for (const removed of ['auth', 'access', 'checkout', 'follow', 'session']) {
      if (removed in client) throw new Error('removed client surface restored: ' + removed);
    }
    client.destroy();
    console.log('smoke-ok ' + SDK_VERSION);
  `;
  writeFileSync(join(pkgDir, 'smoke.mjs'), smoke);
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(`file://${join(pkgDir, 'smoke.mjs')}`)});`,
    ],
    { encoding: 'utf8', cwd: pkgDir },
  );
  if (!output.includes('smoke-ok')) throw new Error(`smoke test failed: ${output}`);

  const manifest = JSON.parse(readFileSync(join(pkgDir, 'dist', 'manifest.json'), 'utf8'));
  if (manifest.apiMajor !== readApiMajor(sdkDir)) {
    throw new Error('manifest apiMajor does not match src/version.ts API_MAJOR');
  }
  if (!manifest.files['index.js']?.sha256) throw new Error('manifest missing index.js digest');
  if (!manifest.files['danmaku.js']?.sha256) throw new Error('manifest missing danmaku.js digest');
  if (!manifest.files['tip.js']?.sha256) throw new Error('manifest missing tip.js digest');
  if (manifest.features?.danmaku !== 'danmaku.js' || manifest.features?.tip !== 'tip.js')
    throw new Error('manifest missing hosted features');

  console.log(`tarball audit passed (${entries.length} entries, ${output.trim()})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
