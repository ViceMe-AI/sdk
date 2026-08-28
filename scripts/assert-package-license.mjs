#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import './assert-release-license.mjs';

const rootLicense = readFileSync(new URL('../LICENSE', import.meta.url));
const packageLicense = readFileSync(new URL('../packages/sdk/LICENSE', import.meta.url));

if (!rootLicense.equals(packageLicense)) {
  throw new Error(
    'release blocked: packages/sdk/LICENSE must exactly match the repository LICENSE',
  );
}

console.log('package license matches repository license');
