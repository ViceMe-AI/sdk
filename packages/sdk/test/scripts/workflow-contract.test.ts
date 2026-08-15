// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(here, '..', '..', '..', '..', '.github', 'workflows');

/**
 * Workflow contract tests: these invariants are cheap to assert on the YAML
 * text and have each been broken in review at least once.
 */

function workflow(name: string): string {
  return readFileSync(join(workflowsDir, name), 'utf8');
}

/** Extract one job's YAML block (from `  <name>:` to the next job). */
function jobBlock(text: string, job: string): string {
  const marker = `\n  ${job}:\n`;
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  // Collect lines until the next job-level key (two spaces + name:).
  const lines = rest.split('\n');
  const block: string[] = [];
  for (const line of lines.slice(1)) {
    if (/^ {2}[\w-]+:/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

describe('workflow contracts', () => {
  it('release assets job receives the recovery state (needs includes context)', () => {
    const assets = jobBlock(workflow('release-package.yml'), 'assets');
    expect(assets).toContain('needs:');
    expect(assets).toContain('- context');
    expect(assets).toContain('- metadata');
    expect(assets).toContain('- npm-publish');
  });

  it('release notification depends on npm, assets, and both S3 regions', () => {
    const notify = jobBlock(workflow('release-package.yml'), 'notify');
    for (const job of ['npm-publish', 'assets', 's3-publication']) {
      expect(notify).toContain(`- ${job}`);
    }
  });

  it('S3 publication uses the dedicated viceme-sdk bucket prefix publicly', () => {
    const text = workflow('release-package.yml');
    expect(text).toContain('https://s3.viceme.cn/viceme-sdk/${VERSION}/');
    expect(text).toContain('https://s3.viceme.ai/viceme-sdk/${VERSION}/');
    expect(text).not.toContain('/sdk/${VERSION}');
    expect(text).not.toContain('/sdk/-/aliases');
  });

  it('no floating action version tags anywhere', () => {
    for (const name of [
      'release-package.yml',
      'promote-cdn.yml',
      'release-assets.yml',
      'quality-gate.yml',
      'feishu.yml',
    ]) {
      const text = workflow(name);
      const floating = [...text.matchAll(/uses:\s*(\S+)@v\d+(?:\.\d+)*\s*$/gm)].map(
        (match) => `${name}: ${match[1]}`,
      );
      expect(floating, JSON.stringify(floating)).toEqual([]);
    }
  });

  it('release entry is the dev-to-main promotion, not direct main Version PRs', () => {
    const text = workflow('release-package.yml');
    // Version PRs are a dev-branch concern.
    expect(text).toContain(
      "name: Version Packages PR (Changesets via Release App, no publishing)\n    if: github.event_name == 'push' && github.ref == 'refs/heads/dev'",
    );
    // The release chain on main only resolves promotion merges / recovery.
    expect(text).toContain(
      "if: (github.event_name == 'push' && github.ref == 'refs/heads/main') || inputs.tag != ''",
    );
  });
});
