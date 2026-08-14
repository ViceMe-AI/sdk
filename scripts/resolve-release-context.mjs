#!/usr/bin/env node
/**
 * Resolve whether a main push is a RELEASE commit (a merged, reviewed
 * "Version Packages" PR) or an ordinary commit, and bind the release to
 * that exact PR merge SHA — ported from the ViceMe-AI/cli baseline
 * (npm/scripts/resolve-release-context.mjs), adapted to Changesets.
 *
 * Why: ordinary feature/doc pushes must never create immutable release tags
 * or publish; only the reviewed Version Packages PR may. Recovery runs
 * check out an already-existing immutable tag instead.
 *
 * Outputs (GitHub Actions `>> $GITHUB_OUTPUT`):
 *   skip=true                        -> ordinary push, nothing to release
 *   skip=false release_ref=<ref>     -> release: the exact merge SHA
 *   recovery=true release_ref=<tag>  -> recovery at an existing tag
 *
 * Env:
 *   GH_TOKEN          github token (repo read access)
 *   GITHUB_REPOSITORY owner/name
 *   GITHUB_SHA        pushed commit (normal mode)
 *   GITHUB_EVENT_NAME push | workflow_dispatch
 *   RECOVERY_TAG      workflow_dispatch input tag (optional)
 */
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const VERSION_PR_TITLE = 'Version Packages';
const repository = process.env.GITHUB_REPOSITORY;
const event = process.env.GITHUB_EVENT_NAME;
const recoveryTag = process.env.RECOVERY_TAG ?? '';
const sha = process.env.GITHUB_SHA ?? '';

function gh(...args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', env: process.env });
}

function output(map) {
  const lines = Object.entries(map)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, lines);
  }
  process.stdout.write(lines);
}

if (event === 'workflow_dispatch') {
  if (!recoveryTag) {
    console.error('workflow_dispatch without a recovery tag: nothing to do');
    output({ skip: 'true' });
    process.exit(0);
  }
  // The tag must already exist (immutable) — recovery never creates one.
  try {
    gh(`repos/${repository}/git/ref/tags/${encodeURIComponent(recoveryTag)}`);
  } catch {
    console.error(`recovery tag ${recoveryTag} does not exist`);
    process.exit(1);
  }
  output({ skip: 'false', recovery: 'true', release_ref: recoveryTag });
  process.exit(0);
}

// Normal push: the commit must be the merge commit of a reviewed Version
// Packages PR — anything else is an ordinary push.
let pulls;
try {
  pulls = JSON.parse(gh(`repos/${repository}/commits/${sha}/pulls`));
} catch (error) {
  console.error(`could not resolve PRs for ${sha}: ${String(error)}`);
  process.exit(1);
}

const releasePr = pulls.find(
  (pr) =>
    pr.state === 'closed' &&
    pr.merged_at !== null &&
    pr.base?.ref === 'main' &&
    pr.title === VERSION_PR_TITLE &&
    pr.merge_commit_sha === sha,
);

if (!releasePr) {
  console.log(`no merged '${VERSION_PR_TITLE}' PR for ${sha}; ordinary push — no release`);
  output({ skip: 'true' });
  process.exit(0);
}

console.log(
  `release commit: ${releasePr.number} "${releasePr.title}" merged at ${releasePr.merge_commit_sha.slice(0, 7)}`,
);
output({ skip: 'false', recovery: 'false', release_ref: releasePr.merge_commit_sha });
