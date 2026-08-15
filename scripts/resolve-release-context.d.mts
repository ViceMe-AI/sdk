interface ReleaseEvent {
  ref?: string;
  after?: string;
}

interface ReleasePullRequest {
  number: number;
  title: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base?: { ref?: string; repo?: { full_name?: string } };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
}

export function resolveReleaseContext(options: {
  eventName: string;
  event: ReleaseEvent;
  recoveryTag: string;
  repository: string;
  workflowRef: string;
  fetchPullRequests: (commit: string) => Promise<ReleasePullRequest[]>;
}): Promise<{
  release_ref: string;
  release_pr_title: string;
  requested_tag: string;
  recovery: 'true' | 'false';
  release_pr_number: string;
}>;
