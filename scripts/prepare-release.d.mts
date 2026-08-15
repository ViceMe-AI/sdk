export interface ReleaseCommit {
  sha: string;
  subject: string;
  body: string;
}

export interface ParsedReleaseCommit extends ReleaseCommit {
  type: string;
  summary: string;
  breaking: boolean;
  group: 'features' | 'fixes' | 'other';
}

export function parseVersion(raw: string): { major: number; minor: number; patch: number };
export function incrementVersion(raw: string, bump: 'major' | 'minor' | 'patch'): string;
export function parseConventionalCommit(commit: ReleaseCommit): ParsedReleaseCommit;
export function selectBump(commits: ParsedReleaseCommit[]): 'major' | 'minor' | 'patch';
export function renderChangelog(
  version: string,
  commits: ReleaseCommit[],
  previous: string,
  date: string,
): string;
export function prepareRelease(options?: { fallbackRef?: string }): {
  version: string;
  bump: 'major' | 'minor' | 'patch';
  base_ref: string;
  commit_count: number;
};
