// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveReleaseContext } from '../../../../scripts/resolve-release-context.mjs';

const repository = 'ViceMe-AI/sdk';
const mergeCommit = 'a'.repeat(40);
const releaseCommit = 'b'.repeat(40);

function releasePullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 8,
    title: 'chore(release): @viceme-ai/sdk@0.2.0',
    merged_at: '2026-08-15T03:42:00Z',
    merge_commit_sha: mergeCommit,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { ref: 'dev', sha: releaseCommit, repo: { full_name: repository } },
    ...overrides,
  };
}

describe('resolve-release-context CLI-aligned policy', () => {
  it('resolves a main push to the exact reviewed dev head', async () => {
    const result = await resolveReleaseContext({
      eventName: 'push',
      event: { ref: 'refs/heads/main', after: mergeCommit },
      recoveryTag: '',
      repository,
      workflowRef: 'refs/heads/main',
      fetchPullRequests: async (commit: string) => {
        expect(commit).toBe(mergeCommit);
        return [releasePullRequest()];
      },
    });
    expect(result).toEqual({
      release_ref: releaseCommit,
      release_pr_title: 'chore(release): @viceme-ai/sdk@0.2.0',
      requested_tag: '',
      recovery: 'false',
      release_pr_number: '8',
    });
  });

  it('rejects unrelated or ambiguous promotion PRs', async () => {
    await expect(
      resolveReleaseContext({
        eventName: 'push',
        event: { ref: 'refs/heads/main', after: mergeCommit },
        recoveryTag: '',
        repository,
        workflowRef: 'refs/heads/main',
        fetchPullRequests: async () => [
          releasePullRequest({
            head: { ref: 'feature', sha: releaseCommit, repo: { full_name: repository } },
          }),
        ],
      }),
    ).rejects.toThrow(/found 0/);

    await expect(
      resolveReleaseContext({
        eventName: 'push',
        event: { ref: 'refs/heads/main', after: mergeCommit },
        recoveryTag: '',
        repository,
        workflowRef: 'refs/heads/main',
        fetchPullRequests: async () => [releasePullRequest(), releasePullRequest({ number: 9 })],
      }),
    ).rejects.toThrow(/found 2/);
  });

  it('accepts manual recovery only for an exact stable SDK tag on main', async () => {
    await expect(
      resolveReleaseContext({
        eventName: 'workflow_dispatch',
        event: {},
        recoveryTag: '@viceme-ai/sdk@0.2.0',
        repository,
        workflowRef: 'refs/heads/main',
        fetchPullRequests: async () => [],
      }),
    ).resolves.toEqual({
      release_ref: '@viceme-ai/sdk@0.2.0',
      release_pr_title: '',
      requested_tag: '@viceme-ai/sdk@0.2.0',
      recovery: 'true',
      release_pr_number: '',
    });

    await expect(
      resolveReleaseContext({
        eventName: 'workflow_dispatch',
        event: {},
        recoveryTag: '@viceme-ai/sdk@0.2.0-next.0',
        repository,
        workflowRef: 'refs/heads/main',
        fetchPullRequests: async () => [],
      }),
    ).rejects.toThrow(/exact stable tag/);
  });
});
