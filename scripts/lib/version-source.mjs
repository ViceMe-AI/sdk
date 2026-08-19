/**
 * Single-source readers for the SDK runtime constants in
 * `packages/sdk/src/version.ts`. Release scripts must derive version facts
 * from there instead of hardcoding literals, so a major bump can never
 * desynchronize the manifest, the loader, and the verification gates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_MAJOR_EXPORT =
  /^[\t ]*export[\t ]+const[\t ]+API_MAJOR(?:[\t ]*:[\t ]*number)?[\t ]*=[\t ]*(\d+)(?:[\t ]+as[\t ]+const)?[\t ]*;?(?:[\t ]*\/\/.*)?$/gm;

/** Parse the one exact exported decimal `API_MAJOR` declaration. */
export function parseApiMajor(source) {
  const matches = [...source.matchAll(API_MAJOR_EXPORT)];
  if (matches.length !== 1) {
    throw new Error(
      `src/version.ts must define exactly one exported decimal API_MAJOR; found ${matches.length}`,
    );
  }
  const value = Number(matches[0][1]);
  if (!Number.isSafeInteger(value)) {
    throw new Error('src/version.ts API_MAJOR must be a safe integer');
  }
  return value;
}

/**
 * Parse the exact exported `API_MAJOR = <n>` declaration from src/version.ts.
 * Throws when it is missing or ambiguous so comments and similarly named
 * compatibility constants can never silently drive the release manifest.
 */
export function readApiMajor(sdkDir) {
  const source = readFileSync(join(sdkDir, 'src', 'version.ts'), 'utf8');
  return parseApiMajor(source);
}
