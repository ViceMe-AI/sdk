#!/usr/bin/env node
/**
 * Offline GitHub Actions workflow gate.
 *
 * GitHub silently skips workflows whose YAML cannot be parsed (the run
 * starts with jobs=[]), so a broken workflow never fails CI by itself.
 * This gate parses every workflow with js-yaml — which rejects duplicate
 * mapping keys, tab indentation, and structural errors — and additionally
 * enforces the repo's action-pinning policy (no floating @vN tags).
 *
 * Run locally via `pnpm workflows:check`; wired into `pnpm check` and the
 * Quality Gate workflow.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(here, '..', '.github', 'workflows');

function dirname(path) {
  return path.slice(0, path.lastIndexOf('/'));
}

const failures = [];
for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
  const text = readFileSync(join(workflowsDir, file), 'utf8');
  try {
    yaml.load(text, { filename: file });
  } catch (error) {
    failures.push(`${file}: ${String(error.message).split('\n').join(' ')}`);
    continue;
  }
  const floating = [...text.matchAll(/uses:\s*(\S+)@v\d+(?:\.\d+)*\s*$/gm)].map(
    (match) => `${file}: floating action tag ${match[1]}`,
  );
  failures.push(...floating);
}

if (failures.length > 0) {
  console.error('workflow check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('workflow check passed');
