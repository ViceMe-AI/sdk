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
    const assets = jobBlock(workflow('release.yml'), 'assets');
    expect(assets).toContain('needs:');
    expect(assets).toContain('- context');
    expect(assets).toContain('- metadata');
    expect(assets).toContain('- npm-publish');
  });

  it('release notification depends on npm, assets, and both S3 regions', () => {
    const notify = jobBlock(workflow('release.yml'), 'notify');
    for (const job of ['npm-publish', 'assets', 's3-publication']) {
      expect(notify).toContain(`- ${job}`);
    }
  });

  it('S3 publication uses the dedicated viceme-sdk bucket prefix publicly', () => {
    const text = workflow('release.yml');
    expect(text).toContain('https://s3.viceme.cn/viceme-sdk/${VERSION}/');
    expect(text).toContain('https://s3.viceme.ai/viceme-sdk/${VERSION}/');
    expect(text).not.toContain('/sdk/${VERSION}');
    expect(text).not.toContain('/sdk/-/aliases');
  });

  it('no floating action version tags anywhere', () => {
    for (const name of [
      'release-pr.yml',
      'release.yml',
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

  it('release preparation matches the CLI authority split', () => {
    const preparation = workflow('release-pr.yml');
    expect(preparation).toContain('name: SDK release preparation');
    expect(preparation).toContain('permission-contents: write');
    expect(preparation).not.toContain('permission-pull-requests');
    expect(preparation).toContain('run: pnpm release:version');
    expect(preparation).toContain('GH_TOKEN: ${{ github.token }}');
    expect(preparation).not.toContain('changesets/action@');
  });

  it('release publication runs only for main promotion merges or recovery', () => {
    const publication = workflow('release.yml');
    expect(publication).toContain('branches: [main]');
    expect(publication).not.toContain('branches: [main, dev]');
    expect(publication).toContain(
      "if: (github.event_name == 'push' && github.ref == 'refs/heads/main') || inputs.tag != ''",
    );
  });
});
