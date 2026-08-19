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
  it('release assets job receives the recovery state from metadata', () => {
    const assets = jobBlock(workflow('release.yml'), 'assets');
    expect(assets).toContain('needs:');
    expect(assets).toContain('- metadata');
    expect(assets).toContain('- npm-publish');
    expect(assets).toContain('RECOVERY: ${{ needs.metadata.outputs.recovery }}');
  });

  it('release notification depends on npm, assets, and both S3 regions', () => {
    const notify = jobBlock(workflow('release.yml'), 'notify');
    for (const job of ['npm-publish', 'assets', 's3-publication']) {
      expect(notify).toContain(`- ${job}`);
    }
  });

  it('release notification matches the CLI AI configuration defaults', () => {
    const notify = jobBlock(workflow('release.yml'), 'notify');
    expect(notify).toContain('FEISHU_RELEASE_WEBHOOK is required');
    expect(notify).toContain('AI_API_KEY is required');
    expect(notify).toContain("ai_model: ${{ secrets.AI_MODEL || 'deepseek-chat' }}");
    expect(notify).toContain(
      "ai_base_url: ${{ secrets.AI_BASE_URL || 'https://api.deepseek.com/v1' }}",
    );
    expect(notify).not.toContain('AI_MODEL is required');
    expect(notify).not.toContain('AI_BASE_URL is required');
  });

  it('release notification presents the same service and version shape as the CLI', () => {
    const notify = jobBlock(workflow('release.yml'), 'notify');
    expect(notify).toContain('service_name: viceme-sdk');
    expect(notify).toContain('tag_name: v${{ needs.metadata.outputs.version }}');
    expect(notify).not.toContain('tag_name: ${{ needs.metadata.outputs.tag }}');
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
      'poc-release.yml',
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
    expect(preparation).toContain('run: pnpm release:prepare');
    expect(preparation).toContain(
      'run: pnpm exec prettier --write packages/sdk/package.json packages/sdk/CHANGELOG.md packages/sdk/src/version.ts',
    );
    expect(preparation).toContain('release preparation must produce a stable semantic version');
    expect(preparation).not.toContain('.changeset');
    expect(preparation).toContain('GH_TOKEN: ${{ github.token }}');
    expect(preparation).not.toContain('changesets/action@');
  });

  it('release publication runs only for main promotion merges or recovery', () => {
    const publication = workflow('release.yml');
    expect(publication).toContain('branches: [main]');
    expect(publication).toContain('DIST_TAG: latest');
    expect(publication).not.toContain('DIST_TAG: next');
    expect(publication).not.toContain('branches: [main, dev]');
    expect(publication).toContain('ref: ${{ steps.context.outputs.release_ref }}');
    expect(publication).toContain('PR_TITLE: ${{ steps.context.outputs.release_pr_title }}');
    expect(publication).not.toContain('skip: ${{ steps.context.outputs.skip }}');
    expect(publication).not.toContain('release:gate');
    expect(publication).not.toContain('License gate');
  });

  it('uses the same token-free npm Trusted Publisher flow as the CLI', () => {
    const npmPublish = jobBlock(workflow('release.yml'), 'npm-publish');
    expect(npmPublish).toContain('id-token: write');
    expect(npmPublish).toContain('npm install --global npm@11.12.1');
    expect(npmPublish).toContain('node scripts/publish-or-verify.mjs');
    expect(npmPublish).not.toContain('environment: npm');
    expect(npmPublish).not.toContain('NPM_TOKEN');
    expect(npmPublish).not.toContain('NODE_AUTH_TOKEN');
    expect(npmPublish).not.toContain('registry-url:');
  });

  it('keeps the manual POC release isolated from formal npm and S3 assets', () => {
    const publication = workflow('poc-release.yml');
    expect(publication).toContain('workflow_dispatch:');
    expect(publication).toContain('test "${GITHUB_REF}" = "refs/heads/poc"');
    expect(publication).toContain("POC_PACKAGE: '@viceme-ai/sdk-poc'");
    expect(publication).toContain('DIST_TAG: poc');
    expect(publication).toContain('node scripts/prepare-poc-package.mjs --version "$VERSION"');
    expect(publication).toContain('id-token: write');
    expect(publication).toContain('npm install --global npm@11.12.1');
    expect(publication).toContain('node scripts/publish-or-verify.mjs');
    expect(publication).not.toContain('registry-url:');
    expect(publication).not.toContain('NODE_AUTH_TOKEN');
    expect(publication).not.toContain('VICEME_POC_NPM_BOOTSTRAP_TOKEN');
    expect(publication).not.toContain('secrets.NPM_TOKEN');
    expect(publication).toContain('--prefix "poc/sdk/releases/v${VERSION}/"');
    expect(publication).toContain('EXPECT_BUCKET: start');
    expect(publication).not.toContain('s3.viceme.cn/viceme-sdk');
    expect(publication).not.toContain('s3.viceme.ai/viceme-sdk');
  });
});
