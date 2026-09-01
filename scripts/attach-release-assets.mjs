#!/usr/bin/env node
/**
 * Authoritative release-asset attachment, sourced from the published npm
 * tarball.
 *
 * Why npm-sourced: CDN artifacts must be byte-identical to what npm serves
 * (§13.3). Downloading the exact published tarball guarantees it — even when
 * re-running after a partial failure.
 *
 * Idempotent + immutable:
 *   - release absent            -> create with all assets
 *   - asset absent              -> upload it
 *   - asset present, identical  -> skip
 *   - asset present, different  -> HARD FAIL (release assets are immutable)
 *
 * This is the recovery path for "npm publish succeeded but the release/assets
 * step failed": re-running the SDK release publication workflow verifies the
 * immutable npm version instead of overwriting it, so this script — via the
 * release-assets.yml workflow — is the convergent, re-runnable authority.
 *
 * Usage:
 *   node scripts/attach-release-assets.mjs --version 1.2.3 [--dry-run] [--repo owner/name]
 *
 * --dry-run stops after npm pack + digest verification + asset staging
 * (no GitHub API calls) so the drill is rehearsal-safe.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function parseArgs(argv) {
  const args = { repo: process.env.GITHUB_REPOSITORY };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--repo') args.repo = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.version) {
  console.error('usage: attach-release-assets.mjs --version <v> [--dry-run] [--repo owner/name]');
  process.exit(2);
}

const tag = `@viceme-ai/sdk@${args.version}`;
const tmp = mkdtempSync(join(tmpdir(), 'viceme-release-assets-'));

function gh(...cliArgs) {
  return execFileSync('gh', cliArgs, { encoding: 'utf8', env: process.env });
}

try {
  // 1+2. Fetch the exact published tarball from npm and verify digests
  // (shared with the S3 publication path — one authoritative byte source).
  const distDir = join(tmp, 'verified-dist');
  execFileSync(
    process.execPath,
    [join(root, 'scripts', 'fetch-npm-dist.mjs'), '--version', args.version, '--out', distDir],
    { stdio: 'inherit' },
  );

  // 3. Stage assets: dist zip + the manifest itself.
  const assetsDir = join(tmp, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  execFileSync('zip', ['-qr', join(assetsDir, `dist-${args.version}.zip`), '.'], {
    cwd: distDir,
  });
  execFileSync('cp', [join(distDir, 'manifest.json'), join(assetsDir, 'manifest.json')]);

  if (args.dryRun) {
    console.log(`dry-run: staged assets for ${tag}:`);
    for (const file of readdirSync(assetsDir)) {
      const digest = createHash('sha256')
        .update(readFileSync(join(assetsDir, file)))
        .digest('hex');
      console.log(`  ${file}  sha256=${digest.slice(0, 16)}…`);
    }
    console.log('dry-run complete; no GitHub API calls were made');
    process.exit(0);
  }

  if (!args.repo) {
    console.error('release assets: --repo or GITHUB_REPOSITORY is required');
    process.exit(1);
  }

  // 4. Attach idempotently (create-if-absent, identical-skip, differ-fail).
  const repoArgs = ['--repo', args.repo];
  let releaseExists = true;
  try {
    gh('release', 'view', tag, ...repoArgs);
  } catch {
    releaseExists = false;
  }

  const staged = readdirSync(assetsDir);
  let toUpload = [...staged];

  if (releaseExists) {
    console.log(`release ${tag} exists; verifying existing assets`);
    const existingDir = join(tmp, 'existing');
    mkdirSync(existingDir, { recursive: true });
    gh('release', 'download', tag, ...repoArgs, '--dir', existingDir, '--clobber');
    toUpload = [];
    for (const file of staged) {
      const existing = join(existingDir, file);
      try {
        readFileSync(existing);
      } catch {
        toUpload.push(file);
        continue;
      }
      execFileSync('cmp', [join(assetsDir, file), existing]);
      console.log(`asset ${file} already attached and byte-identical`);
    }
    if (toUpload.length > 0) {
      gh('release', 'upload', tag, ...repoArgs, ...toUpload.map((f) => join(assetsDir, f)));
    }
  } else {
    gh(
      'release',
      'create',
      tag,
      ...repoArgs,
      '--verify-tag',
      '--title',
      tag,
      '--notes',
      `Release artifacts for ${args.version}, sourced from the published npm tarball and published to both exact-version S3 paths.`,
      ...staged.map((f) => join(assetsDir, f)),
    );
  }
  console.log(`release assets attached for ${tag}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
