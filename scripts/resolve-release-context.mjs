#!/usr/bin/env node

// Ported from ViceMe-AI/cli npm/scripts/resolve-release-context.mjs. A normal
// release publishes the exact reviewed dev head, not the main merge commit;
// manual recovery accepts only an existing stable SDK tag from main.
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const stableTagPattern = /^@viceme-ai\/sdk@\d+\.\d+\.\d+$/;
const commitPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function resolveReleaseContext({
  eventName,
  event,
  recoveryTag,
  repository,
  workflowRef,
  fetchPullRequests,
}) {
  if (!repositoryPattern.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must identify one GitHub owner/repository');
  }

  if (eventName === 'workflow_dispatch') {
    if (workflowRef !== 'refs/heads/main') {
      throw new Error('manual recovery must run from the protected main branch');
    }
    if (!stableTagPattern.test(recoveryTag)) {
      throw new Error('manual recovery requires an exact stable tag such as @viceme-ai/sdk@1.2.3');
    }
    return {
      release_ref: recoveryTag,
      release_pr_title: '',
      requested_tag: recoveryTag,
      recovery: 'true',
      release_pr_number: '',
    };
  }

  if (eventName !== 'push') throw new Error(`unsupported release event ${eventName}`);
  if (event.ref !== 'refs/heads/main') {
    throw new Error('normal release publication must be triggered by a push to main');
  }
  if (!commitPattern.test(event.after ?? '')) {
    throw new Error('push event does not contain a valid main commit');
  }

  const pullRequests = await fetchPullRequests(event.after);
  const releasePullRequests = pullRequests.filter(
    (pullRequest) =>
      pullRequest.merged_at &&
      pullRequest.merge_commit_sha === event.after &&
      pullRequest.base?.ref === 'main' &&
      pullRequest.base?.repo?.full_name === repository &&
      pullRequest.head?.ref === 'dev' &&
      pullRequest.head?.repo?.full_name === repository,
  );
  if (releasePullRequests.length !== 1) {
    throw new Error(
      `main commit must resolve to exactly one merged repository-owned dev to main PR; found ${releasePullRequests.length}`,
    );
  }

  const pullRequest = releasePullRequests[0];
  if (!commitPattern.test(pullRequest.head.sha ?? '')) {
    throw new Error('release PR does not contain a valid reviewed dev head');
  }
  if (typeof pullRequest.title !== 'string' || pullRequest.title === '') {
    throw new Error('release PR title is missing');
  }

  return {
    release_ref: pullRequest.head.sha,
    release_pr_title: pullRequest.title,
    requested_tag: '',
    recovery: 'false',
    release_pr_number: String(pullRequest.number),
  };
}

async function fetchAssociatedPullRequests(commit) {
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const apiURL = requiredEnvironment('GITHUB_API_URL');
  const token = requiredEnvironment('GH_TOKEN');
  const response = await fetch(
    `${apiURL}/repos/${repository}/commits/${commit}/pulls?per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `could not resolve the merged Release PR for ${commit}: ${response.status} ${detail}`,
    );
  }
  const pullRequests = await response.json();
  if (!Array.isArray(pullRequests)) {
    throw new Error('GitHub returned an invalid associated PR response');
  }
  return pullRequests;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const event = JSON.parse(await readFile(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8'));
  const context = await resolveReleaseContext({
    eventName: requiredEnvironment('GITHUB_EVENT_NAME'),
    event,
    recoveryTag: process.env.RECOVERY_TAG ?? '',
    repository: requiredEnvironment('GITHUB_REPOSITORY'),
    workflowRef: requiredEnvironment('GITHUB_REF'),
    fetchPullRequests: fetchAssociatedPullRequests,
  });
  const output = Object.entries(context)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  await appendFile(requiredEnvironment('GITHUB_OUTPUT'), `${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
