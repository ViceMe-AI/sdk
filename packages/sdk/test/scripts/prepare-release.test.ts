// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  incrementVersion,
  parseConventionalCommit,
  renderChangelog,
  selectBump,
} from '../../../../scripts/prepare-release.mjs';

const prepareReleaseScript = fileURLToPath(
  new URL('../../../../scripts/prepare-release.mjs', import.meta.url),
);

const commit = (subject: string, body = '', sha = '1234567890abcdef') => ({
  subject,
  body,
  sha,
});

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function runIsolatedRelease(subject: string) {
  const repo = mkdtempSync(join(tmpdir(), 'viceme-sdk-release-'));
  try {
    mkdirSync(join(repo, 'packages/sdk/src'), { recursive: true });
    writeFileSync(
      join(repo, 'packages/sdk/package.json'),
      `${JSON.stringify({ name: '@viceme-ai/sdk', version: '0.1.6' }, null, 2)}\n`,
    );
    writeFileSync(
      join(repo, 'packages/sdk/src/version.ts'),
      "export const API_MAJOR = 1;\nexport const SDK_VERSION = '0.1.6';\n",
    );
    writeFileSync(
      join(repo, 'packages/sdk/CHANGELOG.md'),
      '# Changelog\n\n## [0.1.6] - 2026-08-01\n\n- Baseline.\n',
    );
    git(repo, ['init', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'ViceMe Test']);
    git(repo, ['config', 'user.email', 'test@viceme.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'chore(sdk): 建立 0.1.6 基线']);
    git(repo, ['tag', 'baseline']);
    writeFileSync(join(repo, 'change.txt'), `${subject}\n`);
    git(repo, ['add', 'change.txt']);
    git(repo, ['commit', '-m', subject]);

    const result = JSON.parse(
      execFileSync(process.execPath, [prepareReleaseScript, '--fallback-ref', 'baseline'], {
        cwd: repo,
        encoding: 'utf8',
      }),
    ) as { bump: string; version: string };
    return {
      changelog: readFileSync(join(repo, 'packages/sdk/CHANGELOG.md'), 'utf8'),
      packageVersion: JSON.parse(readFileSync(join(repo, 'packages/sdk/package.json'), 'utf8'))
        .version as string,
      result,
      runtime: readFileSync(join(repo, 'packages/sdk/src/version.ts'), 'utf8'),
      status: git(repo, ['status', '--short'])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort(),
    };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

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

  it.each([
    {
      bump: 'minor',
      subject: 'feat(sdk): add hosted controls readiness',
      version: '0.2.0',
    },
    {
      bump: 'patch',
      subject: 'fix(sdk): reject an unready frame',
      version: '0.1.7',
    },
  ])(
    'updates package, runtime, and changelog together for a $bump release',
    ({ bump, subject, version }) => {
      const generated = runIsolatedRelease(subject);

      expect(generated.result).toMatchObject({ bump, version });
      expect(generated.packageVersion).toBe(version);
      expect(generated.runtime).toContain(`export const SDK_VERSION = '${version}';`);
      expect(generated.changelog).toContain(`## [${version}]`);
      expect(generated.status).toEqual([
        'M packages/sdk/CHANGELOG.md',
        'M packages/sdk/package.json',
        'M packages/sdk/src/version.ts',
      ]);
    },
  );
});
