// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  incrementVersion,
  parseConventionalCommit,
  renderChangelog,
  selectBump,
} from '../../../../scripts/prepare-release.mjs';

const commit = (subject: string, body = '', sha = '1234567890abcdef') => ({
  subject,
  body,
  sha,
});

describe('prepare-release CLI-aligned policy', () => {
  it('selects semantic version bumps from Conventional Commits', () => {
    expect(selectBump([parseConventionalCommit(commit('fix: repair loader'))])).toBe('patch');
    expect(selectBump([parseConventionalCommit(commit('feat(sdk): add capability'))])).toBe(
      'minor',
    );
    expect(selectBump([parseConventionalCommit(commit('feat!: replace contract'))])).toBe('major');
    expect(
      selectBump([
        parseConventionalCommit(commit('fix: repair transport', 'BREAKING CHANGE: incompatible')),
      ]),
    ).toBe('major');
  });

  it('increments stable versions and rejects prerelease input', () => {
    expect(incrementVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(incrementVersion('0.1.9', 'minor')).toBe('0.2.0');
    expect(incrementVersion('0.9.0', 'major')).toBe('1.0.0');
    expect(() => incrementVersion('0.2.0-next.0', 'patch')).toThrow(
      'invalid stable semantic version',
    );
  });

  it('renders the CLI changelog layout and preserves history', () => {
    const changelog = renderChangelog(
      '0.2.0',
      [
        commit('fix: reject stale target', '', 'aaaaaaaaaa'),
        commit('feat(sdk): add release automation', '', 'bbbbbbbbbb'),
        commit('docs: explain installation', '', 'cccccccccc'),
      ],
      '# Changelog\n\n## [0.1.0] - 2026-08-01\n\n- Initial release.\n',
      '2026-08-15',
    );
    expect(changelog).toMatch(/## \[0\.2\.0\] - 2026-08-15/);
    expect(changelog).toMatch(/### Features\n\n- add release automation \(`bbbbbbb`\)/);
    expect(changelog).toMatch(/### Fixes\n\n- reject stale target \(`aaaaaaa`\)/);
    expect(changelog).toMatch(/### Other Changes\n\n- explain installation \(`ccccccc`\)/);
    expect(changelog).toMatch(/## \[0\.1\.0\] - 2026-08-01/);
  });
});
