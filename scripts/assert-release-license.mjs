#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const license = new URL('../LICENSE', import.meta.url);
const pending = new URL('../LICENSE-PENDING.md', import.meta.url);

if (existsSync(pending)) {
  throw new Error(
    'release blocked: remove LICENSE-PENDING.md only after approving a final LICENSE',
  );
}
if (!existsSync(license) || readFileSync(license, 'utf8').trim() === '') {
  throw new Error('release blocked: a non-empty repository LICENSE is required');
}

console.log('release license gate passed');
