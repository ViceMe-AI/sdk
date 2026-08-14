#!/usr/bin/env node
/**
 * Scan tracked files for forbidden patterns:
 * - private/internal hostnames (Shop preview URLs, internal platforms);
 * - credential-shaped secrets (tokens, keys) in source;
 * - workspace:/git dependencies inside publishable package manifests.
 *
 * Failures block the PR. Examples use fictional keys and mock endpoints only.
 */
import { execFileSync } from 'node:child_process';

const FORBIDDEN = [
  {
    name: 'internal platform hostnames',
    pattern: /(zeabur\.app|vercel\.app\/viceme|internal\.viceme|admin\.viceme|localhost:\d+\/api)/i,
    allow: /(^|\/)(test|scripts)\/|\.test\.ts$|\.spec\.ts$|serve\.mjs$/,
  },
  {
    name: 'credential-shaped assignments',
    pattern: /(api[_-]?secret|private[_-]?key|webhook[_-]?secret|Bearer\s+[A-Za-z0-9._-]{20,})/i,
    // Workflows and the runbook reference SECRET NAMES only (values stay in
    // GitHub); tests and docs of policy are also textual.
    allow:
      /(^|\/)(test|scripts)\/|\.test\.ts$|\.spec\.ts$|SECURITY\.md$|CONTRIBUTING\.md$|\.github\/workflows\/|docs\/RELEASE\.md$/,
  },
];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(
    (f) =>
      f.length > 0 &&
      /\.(ts|tsx|js|mjs|json|html|md|yml|yaml)$/.test(f) &&
      !f.startsWith('pnpm-lock.yaml'),
  );

let failures = 0;
for (const file of files) {
  let content;
  try {
    content = execFileSync('cat', [file], { encoding: 'utf8' });
  } catch {
    continue;
  }
  for (const rule of FORBIDDEN) {
    if (rule.allow?.test(file)) continue;
    const match = content.match(rule.pattern);
    if (match) {
      console.error(`forbidden pattern [${rule.name}] in ${file}: ${match[0].slice(0, 60)}`);
      failures += 1;
    }
  }
}

// Publishable packages must not carry workspace or git dependencies.
for (const pkgFile of files.filter((f) => f.endsWith('package.json'))) {
  const pkg = JSON.parse(execFileSync('cat', [pkgFile], { encoding: 'utf8' }));
  if (pkg.private === true) continue;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (String(spec).startsWith('workspace:') || String(spec).startsWith('git')) {
      console.error(`non-private package ${pkgFile} has workspace/git dependency: ${name}@${spec}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`scan failed with ${failures} finding(s)`);
  process.exit(1);
}
console.log('forbidden-pattern scan passed');
