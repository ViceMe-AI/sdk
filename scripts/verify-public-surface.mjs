#!/usr/bin/env node
/**
 * Public surface verification for `@viceme-ai/sdk`.
 *
 * Locks the published hosted engagement and Website Work access surface:
 * - exports map contains core, testing, danmaku, tip, and scoped Tip testing;
 * - declared dist artifacts exist (js + d.ts);
 * - internal capability modules do not become package subpaths;
 * - runtime version constant matches package.json;
 * - loader requests stay inside the Shop runtime proxy allowlist.
 */
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  JSON.stringify(exportKeys) ===
    JSON.stringify(['.', './danmaku', './testing', './tip', './tip/testing']),
  `exports map is unexpected: ${JSON.stringify(exportKeys)}`,
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

const danmakuRuntimeSymbols = Object.keys(
  await import(pathToFileURL(join(distDir, 'danmaku.js')).href),
).sort();
check(
  JSON.stringify(danmakuRuntimeSymbols) === JSON.stringify(['mountDanmaku']),
  `./danmaku runtime symbols must be exactly ["mountDanmaku"], got ${JSON.stringify(danmakuRuntimeSymbols)}`,
);

const danmakuDeclarations = await readFile(join(distDir, 'danmaku', 'index.d.ts'), 'utf8');
const danmakuTypeSymbols = [
  ...danmakuDeclarations.matchAll(
    /^export (?:declare )?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ),
]
  .map((match) => match[1])
  .sort();
check(
  !/^export\s*{/m.test(danmakuDeclarations),
  './danmaku declarations must not re-export internal symbols',
);
check(
  JSON.stringify(danmakuTypeSymbols) ===
    JSON.stringify(['DanmakuMountHandle', 'DanmakuMountOptions', 'mountDanmaku']),
  `./danmaku declaration symbols are unexpected: ${JSON.stringify(danmakuTypeSymbols)}`,
);

const tipRuntimeSymbols = Object.keys(
  await import(pathToFileURL(join(distDir, 'tip.js')).href),
).sort();
check(
  JSON.stringify(tipRuntimeSymbols) === JSON.stringify(['createTip', 'mountTip']),
  `./tip runtime symbols must be exactly ["createTip", "mountTip"], got ${JSON.stringify(tipRuntimeSymbols)}`,
);

const tipDeclarations = await readFile(join(distDir, 'tip', 'index.d.ts'), 'utf8');
const tipTypeSymbols = [
  ...tipDeclarations.matchAll(
    /^export (?:declare )?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ),
]
  .map((match) => match[1])
  .sort();
check(
  !/^export\s*{/m.test(tipDeclarations),
  './tip declarations must not re-export internal symbols',
);
check(
  JSON.stringify(tipTypeSymbols) ===
    JSON.stringify([
      'TipClient',
      'TipConfig',
      'TipMountHandle',
      'TipMountOptions',
      'TipOpenOptions',
      'TipOpenResult',
      'TipPaidDetail',
      'TipProvider',
      'TipWidgetCloseDetail',
      'createTip',
      'mountTip',
    ]),
  `./tip declaration symbols are unexpected: ${JSON.stringify(tipTypeSymbols)}`,
);

const tipTestingRuntimeSymbols = Object.keys(
  await import(pathToFileURL(join(distDir, 'tip', 'testing.js')).href),
).sort();
check(
  JSON.stringify(tipTestingRuntimeSymbols) === JSON.stringify(['createTestTip']),
  `./tip/testing runtime symbols are unexpected: ${JSON.stringify(tipTestingRuntimeSymbols)}`,
);

const tipTestingDeclarations = await readFile(join(distDir, 'tip', 'testing.d.ts'), 'utf8');
const tipTestingTypeSymbols = [
  ...tipTestingDeclarations.matchAll(
    /^export (?:declare )?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ),
]
  .map((match) => match[1])
  .sort();
check(
  JSON.stringify(tipTestingTypeSymbols) ===
    JSON.stringify(['TipTestOptions', 'TipTestOutcome', 'createTestTip']),
  `./tip/testing declaration symbols are unexpected: ${JSON.stringify(tipTestingTypeSymbols)}`,
);

const testingRuntimeSymbols = Object.keys(
  await import(pathToFileURL(join(distDir, 'testing.js')).href),
).sort();
check(
  JSON.stringify(testingRuntimeSymbols) ===
    JSON.stringify(['FIXTURE_WORK', 'createMemoryTransport', 'createTestViceMe']),
  `./testing runtime symbols are unexpected: ${JSON.stringify(testingRuntimeSymbols)}`,
);

for (const removed of ['access', 'auth', 'checkout', 'follow', 'payment', 'purchase', 'session']) {
  check(
    !exportKeys.includes(`./${removed}`),
    `removed subpath "./${removed}" must not be exported`,
  );
  await access(join(distDir, `${removed}.js`), constants.R_OK)
    .then(() => failures.push(`${removed}.js exists in dist but is not public`))
    .catch(() => {});
}

for (const required of [
  'viceme.min.js',
  'danmaku.js',
  'tip.js',
  'testing.js',
  'tip/testing.js',
  'manifest.json',
]) {
  await access(join(distDir, required), constants.R_OK).catch(() =>
    failures.push(`hosted runtime dist/${required} missing`),
  );
}

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
  JSON.stringify(manifest.features ?? {}) ===
    JSON.stringify({ danmaku: 'danmaku.js', tip: 'tip.js' }),
  'production manifest must declare exactly danmaku.js and tip.js',
);

const loaderSource = await readFile(join(distDir, 'viceme.min.js'), 'utf8');
check(!loaderSource.includes('index.js'), 'loader must inline core instead of requesting index.js');

const runtimeFiles = Object.keys(manifest.files ?? {}).filter(
  (file) =>
    file === 'index.js' ||
    file === 'danmaku.js' ||
    file === 'testing.js' ||
    file === 'tip.js' ||
    file === 'tip/testing.js' ||
    file === 'viceme.min.js' ||
    file.startsWith('chunks/'),
);
for (const file of runtimeFiles) {
  const source = await readFile(join(distDir, file), 'utf8');
  for (const forbidden of ['/v1/public/v1/']) {
    check(!source.includes(forbidden), `${file} contains removed runtime pattern ${forbidden}`);
  }
}

const pending = ['danmaku.js', 'testing.js', 'tip.js', 'tip/testing.js'];
const visited = new Set();
while (pending.length > 0) {
  const file = pending.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const source = await readFile(join(distDir, file), 'utf8');
  const references = [...source.matchAll(/["'](\.{1,2}\/.+?\.js)["']/g)].map((match) => match[1]);
  for (const specifier of references) {
    const reference = posix.normalize(posix.join(posix.dirname(file), specifier));
    const proxyAllowed = /^chunks\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.js$/.test(reference);
    check(proxyAllowed, `${file} references Shop-proxy-blocked asset ${specifier} (${reference})`);
    const described = manifest.files?.[reference] !== undefined;
    check(described, `manifest does not describe referenced asset ${reference}`);
    if (proxyAllowed && described && !visited.has(reference)) pending.push(reference);
  }
}

if (failures.length > 0) {
  console.error('public surface verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('public surface verification passed');
