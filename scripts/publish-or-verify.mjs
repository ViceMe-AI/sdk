#!/usr/bin/env node
/**
 * Publish or verify — convergent npm publication for the approved SDK channel.
 *
 * Ported from ViceMe-AI/cli npm/scripts/publish-or-verify.mjs (the reviewed
 * OIDC baseline), adapted for this package:
 *   - package lives at packages/sdk;
 *   - formal releases are @viceme-ai/sdk stable versions under `latest`;
 *   - POC releases are @viceme-ai/sdk-poc x.y.z-poc.N under `poc`;
 *
 * Flow (Trusted Publisher OIDC only, matching ViceMe-AI/cli):
 *   1. npm pack --dry-run locally -> integrity for the exact package id;
 *   2. npm view <id> dist.integrity:
 *        already published, same integrity  -> verify dist-tags, done (0);
 *        already published, other integrity -> refuse (immutable);
 *        not found                          -> npm publish --provenance;
 *   3. read the published integrity back (bounded retries) and require a
 *      match; then enforce the dist-tag policy.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { decideMutableTagMove } from './lib/release-policy.mjs';

const registry = 'https://registry.npmjs.org';
const registryArguments = [`--registry=${registry}`, `--@viceme-ai:registry=${registry}`];
const packageDir = new URL('../packages/sdk/', import.meta.url).pathname;

const packageDocument = JSON.parse(
  await readFile(new URL('../packages/sdk/package.json', import.meta.url), 'utf8'),
);
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
const POC_SEMVER = /^\d+\.\d+\.\d+-poc\.\d+$/;
const packageID = `${packageDocument.name}@${packageDocument.version}`;
const distTag = process.env.DIST_TAG ?? 'latest';
const isStable =
  packageDocument.name === '@viceme-ai/sdk' &&
  STABLE_SEMVER.test(packageDocument.version) &&
  distTag === 'latest';
const isPoc =
  packageDocument.name === '@viceme-ai/sdk-poc' &&
  POC_SEMVER.test(packageDocument.version) &&
  distTag === 'poc';
if (!isStable && !isPoc) {
  throw new Error(
    `refusing unapproved package/channel combination ${packageID} under '${distTag}'`,
  );
}

function run(command, arguments_, inherit = true) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    cwd: packageDir,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed with status ${result.status}\n${
        inherit ? '' : `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      }`,
    );
  }
  return result;
}

function viewJson(spec, field) {
  return spawnSync('npm', ['view', spec, field, '--json', ...registryArguments], {
    encoding: 'utf8',
    cwd: packageDir,
  });
}

function isNotFound(output) {
  return /E404|not found|not exist/i.test(output);
}

async function readPublishedIntegrity() {
  // npm can accept a publish before the public metadata endpoint exposes it;
  // eleven reads wait at most ~5 minutes with capped backoff.
  let delay = 1_000;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const result = viewJson(packageID, 'dist.integrity');
    if (result.status === 0 && result.stdout.trim() !== '') {
      return JSON.parse(result.stdout);
    }
    await wait(delay);
    delay = Math.min(delay * 2, 60_000);
  }
  throw new Error(`${packageID} did not become visible on the registry`);
}

async function readDistTags() {
  const result = viewJson(packageDocument.name, 'dist-tags');
  if (result.status !== 0) {
    throw new Error(`could not read dist-tags: ${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

async function enforceDistTagPolicy() {
  let tags = await readDistTags();
  if (tags[distTag] !== packageDocument.version) {
    // Monotonic forward move only: a stale rerun of an older release must
    // never pull the dist-tag backward past a newer release.
    const decision = decideMutableTagMove({
      mode: 'promote',
      current: tags[distTag],
      target: packageDocument.version,
    });
    if (!decision.allowed) {
      // A stale rerun for an already-superseded version is still converged:
      // the exact package is on npm with matching integrity; only the tag
      // stays with the newer release.
      process.stdout.write(`dist-tag '${distTag}' stays at ${tags[distTag]}: ${decision.reason}\n`);
      return;
    }
    run('npm', ['dist-tag', 'add', packageID, distTag, ...registryArguments]);
    tags = await readDistTags();
    if (tags[distTag] !== packageDocument.version) {
      throw new Error(`dist-tag '${distTag}' still does not point at ${packageID}`);
    }
  }
  process.stdout.write(`dist-tag ok: ${distTag} -> ${packageDocument.version}\n`);
}

const packed = run('npm', ['pack', '--json', '--dry-run', ...registryArguments], false);
const packReport = JSON.parse(packed.stdout)[0];
if (packReport.id !== packageID || !packReport.integrity) {
  throw new Error(`local npm pack did not produce ${packageID}`);
}

const remote = viewJson(packageID, 'dist.integrity');
if (remote.status === 0 && remote.stdout.trim() !== '') {
  const remoteIntegrity = JSON.parse(remote.stdout);
  if (remoteIntegrity !== packReport.integrity) {
    throw new Error(
      `${packageID} is already published with different integrity; refusing to overwrite or treat it as recovered`,
    );
  }
  await enforceDistTagPolicy();
  process.stdout.write(`${packageID} is already published with matching integrity\n`);
  process.exit(0);
}

if (!isNotFound(`${remote.stdout}\n${remote.stderr}`)) {
  throw new Error(
    `could not safely determine npm publication state:\n${remote.stdout}\n${remote.stderr}`,
  );
}

run('npm', [
  'publish',
  '--access',
  'public',
  '--provenance',
  `--tag`,
  distTag,
  ...registryArguments,
]);

const publishedIntegrity = await readPublishedIntegrity();
if (publishedIntegrity !== packReport.integrity) {
  throw new Error(
    `${packageID} became visible after publish with different integrity; refusing to treat it as recovered`,
  );
}
await enforceDistTagPolicy();
process.stdout.write(`published ${packageID} under '${distTag}'\n`);
