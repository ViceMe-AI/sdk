#!/usr/bin/env node
/**
 * Public surface verification for `@viceme-ai/sdk`.
 *
 * Locks the published surface to the intended B0 shape:
 * - exports map contains exactly `.` and `./testing`;
 * - declared dist artifacts exist (js + d.ts);
 * - no unreleased capability subpath sneaks in;
 * - runtime version constant matches package.json;
 * - release manifest major/features are consistent.
 */
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApiMajor } from './lib/version-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = join(here, '..', 'packages', 'sdk');
const distDir = join(sdkDir, 'dist');

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const pkg = JSON.parse(await readFile(join(sdkDir, 'package.json'), 'utf8'));

const exportKeys = Object.keys(pkg.exports ?? {}).sort();
check(
  JSON.stringify(exportKeys) === JSON.stringify(['.', './testing']),
  `exports map must be exactly [".", "./testing"], got ${JSON.stringify(exportKeys)}`,
);

for (const [subpath, def] of Object.entries(pkg.exports ?? {})) {
  const importPath = def.import;
  const typesPath = def.types;
  check(typeof importPath === 'string', `${subpath} missing "import" target`);
  check(typeof typesPath === 'string', `${subpath} missing "types" target`);
  if (typeof importPath === 'string') {
    await access(join(sdkDir, importPath), constants.R_OK).catch(() =>
      failures.push(`${subpath} import target missing: ${importPath}`),
    );
  }
  if (typeof typesPath === 'string') {
    await access(join(sdkDir, typesPath), constants.R_OK).catch(() =>
      failures.push(`${subpath} types target missing: ${typesPath}`),
    );
  }
}

for (const unreleased of ['danmaku', 'payment']) {
  check(
    !exportKeys.includes(`./${unreleased}`),
    `unreleased capability subpath "./${unreleased}" must not be exported`,
  );
  await access(join(distDir, `${unreleased}.js`), constants.R_OK)
    .then(() => failures.push(`${unreleased}.js exists in dist but is not released`))
    .catch(() => {});
}

await access(join(distDir, 'viceme.min.js'), constants.R_OK).catch(() =>
  failures.push('CDN loader dist/viceme.min.js missing'),
);

const versionSource = await readFile(join(sdkDir, 'src', 'version.ts'), 'utf8');
check(
  versionSource.includes(`SDK_VERSION = '${pkg.version}'`),
  `src/version.ts SDK_VERSION must match package.json version ${pkg.version}`,
);

const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
check(manifest.version === pkg.version, 'manifest version must match package.json');
check(
  manifest.apiMajor === readApiMajor(sdkDir),
  'manifest apiMajor must match src/version.ts API_MAJOR',
);
check(
  Object.keys(manifest.features ?? {}).length === 0,
  'production manifest must not declare unreleased features',
);

if (failures.length > 0) {
  console.error('public surface verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('public surface verification passed');
