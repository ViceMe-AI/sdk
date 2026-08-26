#!/usr/bin/env node
/**
 * Public surface verification for `@viceme-ai/sdk`.
 *
 * Locks the published surface to the intended creator access and danmaku shape:
 * - exports map contains core, danmaku, and testing;
 * - declared dist artifacts exist (js + d.ts);
 * - runtime version constant matches package.json;
 * - loader requests stay inside the Shop runtime proxy allowlist.
 */
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
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
  JSON.stringify(exportKeys) === JSON.stringify(['.', './danmaku', './testing']),
  `exports map must be exactly [".", "./danmaku", "./testing"], got ${JSON.stringify(exportKeys)}`,
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

for (const unreleased of ['payment']) {
  check(
    !exportKeys.includes(`./${unreleased}`),
    `unreleased capability subpath "./${unreleased}" must not be exported`,
  );
  await access(join(distDir, `${unreleased}.js`), constants.R_OK)
    .then(() => failures.push(`${unreleased}.js exists in dist but is not released`))
    .catch(() => {});
}

for (const required of ['viceme.min.js', 'danmaku.js', 'manifest.json']) {
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
  JSON.stringify(manifest.features ?? {}) === JSON.stringify({ danmaku: 'danmaku.js' }),
  'production manifest must declare only danmaku.js',
);

const loaderSource = await readFile(join(distDir, 'viceme.min.js'), 'utf8');
check(!loaderSource.includes('index.js'), 'loader must inline core instead of requesting index.js');

const pending = ['danmaku.js'];
const visited = new Set();
while (pending.length > 0) {
  const file = pending.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const source = await readFile(join(distDir, file), 'utf8');
  const references = [...source.matchAll(/["']\.\/(.+?\.js)["']/g)].map((match) => match[1]);
  for (const reference of references) {
    check(
      /^chunks\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.js$/.test(reference),
      `${file} references Shop-proxy-blocked asset ${reference}`,
    );
    check(manifest.files?.[reference], `manifest does not describe referenced asset ${reference}`);
    if (!visited.has(reference)) pending.push(reference);
  }
}

if (failures.length > 0) {
  console.error('public surface verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('public surface verification passed');
