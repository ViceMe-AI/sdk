#!/usr/bin/env node

// Ported from ViceMe-AI/cli npm/scripts/prepare-release.mjs. The version
// selection, Conventional Commit parsing, changelog layout, stable-semver
// policy, and rerun behavior intentionally stay aligned with the CLI.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseTagPrefix = '@viceme-ai/sdk@';
const packageFilename = 'packages/sdk/package.json';
const runtimeVersionFilename = 'packages/sdk/src/version.ts';
const changelogFilename = 'packages/sdk/CHANGELOG.md';

export function parseVersion(raw) {
  const match = semverPattern.exec(raw.trim());
  if (!match) throw new Error(`invalid stable semantic version: ${raw}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function incrementVersion(raw, bump) {
  const version = parseVersion(raw);
  if (bump === 'major') return `${version.major + 1}.0.0`;
  if (bump === 'minor') return `${version.major}.${version.minor + 1}.0`;
  if (bump === 'patch') return `${version.major}.${version.minor}.${version.patch + 1}`;
  throw new Error(`unsupported version bump: ${bump}`);
}

export function parseConventionalCommit(commit) {
  const subject = commit.subject.trim();
  const conventional = /^([a-zA-Z][\w-]*)(?:\([^)]*\))?(!)?:\s+(.+)$/.exec(subject);
  const type = conventional?.[1]?.toLowerCase() ?? 'other';
  const summary = conventional?.[3]?.trim() ?? subject;
  const breaking = Boolean(conventional?.[2]) || /(^|\n)BREAKING[ -]CHANGE:\s+/i.test(commit.body);
  let group = 'other';
  if (type === 'feat') group = 'features';
  else if (type === 'fix' || type === 'perf') group = 'fixes';
  return { ...commit, type, summary, breaking, group };
}

export function selectBump(commits) {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  return 'patch';
}

export function renderChangelog(version, commits, previous, date) {
  const parsed = commits.map(parseConventionalCommit);
  const sections = [
    ['Breaking Changes', parsed.filter((commit) => commit.breaking)],
    ['Features', parsed.filter((commit) => !commit.breaking && commit.group === 'features')],
    ['Fixes', parsed.filter((commit) => !commit.breaking && commit.group === 'fixes')],
    ['Other Changes', parsed.filter((commit) => !commit.breaking && commit.group === 'other')],
  ];
  const lines = ['# Changelog', '', `## [${version}] - ${date}`, ''];
  for (const [heading, entries] of sections) {
    if (entries.length === 0) continue;
    lines.push(`### ${heading}`, '');
    for (const entry of entries) lines.push(`- ${entry.summary} (\`${entry.sha.slice(0, 7)}\`)`);
    lines.push('');
  }
  const oldBody = previous.replace(/^# Changelog\s*/u, '').trim();
  if (oldBody !== '') lines.push(oldBody, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowFailure ? 'pipe' : 'inherit'],
  }).trim();
}

function gitOptional(args) {
  try {
    return git(args, { allowFailure: true });
  } catch {
    return '';
  }
}

function latestReleaseTag() {
  const tags = gitOptional(['tag', '--list', `${releaseTagPrefix}[0-9]*`, '--sort=-v:refname'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.find((tag) => semverPattern.test(tag.slice(releaseTagPrefix.length))) ?? '';
}

function commitsSince(ref) {
  const record = '%H%x1f%s%x1f%b%x1e';
  const output = gitOptional(['log', '--no-merges', `--format=${record}`, `${ref}..HEAD`]);
  if (output === '') return [];
  return output
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body = ''] = entry.split('\x1f');
      return { sha, subject, body };
    })
    .filter(
      (commit) => !/^chore\(release\):\s+@viceme-ai\/sdk@\d+\.\d+\.\d+$/i.test(commit.subject),
    );
}

function readAtRef(ref, filename) {
  return gitOptional(['show', `${ref}:${filename}`]);
}

function writeJSON(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

export function prepareRelease({ fallbackRef = 'origin/main' } = {}) {
  const releaseTag = latestReleaseTag();
  const baseRef = releaseTag || fallbackRef;
  if (!gitOptional(['rev-parse', '--verify', baseRef])) {
    throw new Error(`release base ref does not exist: ${baseRef}`);
  }

  const commits = commitsSince(baseRef);
  if (commits.length === 0) throw new Error(`no unreleased commits found after ${baseRef}`);

  const packageDocument = JSON.parse(readFileSync(packageFilename, 'utf8'));
  const basePackage = readAtRef(baseRef, packageFilename);
  const previousVersion =
    basePackage !== ''
      ? JSON.parse(basePackage).version
      : releaseTag.slice(releaseTagPrefix.length);
  const parsedCommits = commits.map(parseConventionalCommit);
  const bump = selectBump(parsedCommits);
  const version = incrementVersion(previousVersion, bump);
  parseVersion(version);

  packageDocument.version = version;
  writeJSON(packageFilename, packageDocument);

  const runtimeSource = readFileSync(runtimeVersionFilename, 'utf8');
  const versionPattern = /export const SDK_VERSION = '[^']+';/g;
  const matches = [...runtimeSource.matchAll(versionPattern)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one SDK_VERSION declaration, found ${matches.length}`);
  }
  writeFileSync(
    runtimeVersionFilename,
    runtimeSource.replace(versionPattern, `export const SDK_VERSION = '${version}';`),
  );

  const previousChangelog = readAtRef(baseRef, changelogFilename);
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(changelogFilename, renderChangelog(version, commits, previousChangelog, date));

  return { version, bump, base_ref: baseRef, commit_count: commits.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fallbackRefIndex = process.argv.indexOf('--fallback-ref');
    const fallbackRef = fallbackRefIndex >= 0 ? process.argv[fallbackRefIndex + 1] : 'origin/main';
    process.stdout.write(`${JSON.stringify(prepareRelease({ fallbackRef }))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
