/**
 * Single-source readers for the SDK runtime constants in
 * `packages/sdk/src/version.ts`. Release scripts must derive version facts
 * from there instead of hardcoding literals, so a major bump can never
 * desynchronize the manifest, the loader, and the verification gates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse `API_MAJOR = <n>` from src/version.ts.
 * Throws when the constant is missing so a malformed source file fails the
 * build loudly instead of silently producing a manifest with a wrong major.
 */
export function readApiMajor(sdkDir) {
  const source = readFileSync(join(sdkDir, 'src', 'version.ts'), 'utf8');
  const match = /API_MAJOR\s*=\s*(\d+)/.exec(source);
  if (!match) throw new Error('src/version.ts does not define API_MAJOR');
  return Number(match[1]);
}
