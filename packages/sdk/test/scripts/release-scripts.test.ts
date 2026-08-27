// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..', '..', '..', '..', 'scripts');

/**
 * Subprocess tests for the release scripts:
 * - upload-plan.mjs: immutability planning (missing / identical / conflict).
 * - verify-npm-dist-tag.mjs: dist-tag read-back policy.
 */

function run(script: string, ...args: string[]) {
  return exec('node', [join(scriptsDir, script), ...args]);
}

/* ------------------------------ upload plan ------------------------------ */

interface ServedFile {
  body: Buffer;
  contentType: string;
}

const distDir = mkdtempSync(join(tmpdir(), 'viceme-upload-plan-'));
const remote = new Map<string, ServedFile>();

let server:
  | {
      url: string;
      close: () => Promise<void>;
    }
  | undefined;

beforeAll(async () => {
  const indexBody = Buffer.from('export const SDK_VERSION = "0.1.0";\n');
  const loaderBody = Buffer.from('(function(){/* loader */})();\n');
  const danmakuBody = Buffer.from('export const mount = () => {};\n');
  const tipBody = Buffer.from('export const mountTip = () => {};\n');
  const digest = (body: Buffer) => ({
    sha256: createHash('sha256').update(body).digest('hex'),
    sri: `sha384-${createHash('sha384').update(body).digest('base64')}`,
    bytes: body.length,
    gzipBytes: body.length,
  });
  writeFileSync(join(distDir, 'index.js'), indexBody);
  writeFileSync(join(distDir, 'viceme.min.js'), loaderBody);
  writeFileSync(join(distDir, 'danmaku.js'), danmakuBody);
  writeFileSync(join(distDir, 'tip.js'), tipBody);
  writeFileSync(
    join(distDir, 'manifest.json'),
    `${JSON.stringify(
      {
        version: '0.1.0',
        apiMajor: 1,
        loader: 'viceme.min.js',
        features: { danmaku: 'danmaku.js', tip: 'tip.js' },
        files: {
          'index.js': digest(indexBody),
          'viceme.min.js': digest(loaderBody),
          'danmaku.js': digest(danmakuBody),
          'tip.js': digest(tipBody),
        },
      },
      null,
      2,
    )}\n`,
  );

  // Remote starts empty; tests mutate it.
  const httpServer: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/viceme-sdk\/[^/]+\//, ''));
    const file = remote.get(path);
    if (!file) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': file.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    });
    res.end(file.body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('bind failed');
  server = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => httpServer.close(() => done())),
  };
});

afterAll(async () => {
  await server?.close();
});

describe('upload-plan.mjs', () => {
  it('lists every file — including manifest.json itself — when the remote is empty', async () => {
    const { stdout } = await run(
      'upload-plan.mjs',
      '--dist',
      distDir,
      '--base',
      `${server!.url}/viceme-sdk/0.1.0/`,
    );
    // manifest.json is a first-class immutable object even though it is not
    // listed inside manifest.files: verify-cdn reads it from this path.
    expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
      'danmaku.js',
      'index.js',
      'manifest.json',
      'tip.js',
      'viceme.min.js',
    ]);
  });

  it('skips byte-identical objects and lists only the missing ones', async () => {
    remote.set('index.js', {
      body: await import('node:fs/promises').then((fs) => fs.readFile(join(distDir, 'index.js'))),
      contentType: 'text/javascript; charset=utf-8',
    });
    const { stdout } = await run(
      'upload-plan.mjs',
      '--dist',
      distDir,
      '--base',
      `${server!.url}/viceme-sdk/0.1.0/`,
    );
    expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
      'danmaku.js',
      'manifest.json',
      'tip.js',
      'viceme.min.js',
    ]);
  });

  it('fails closed when the remote object has different bytes', async () => {
    remote.set('index.js', {
      body: Buffer.from('tampered content\n'),
      contentType: 'text/javascript; charset=utf-8',
    });
    await expect(
      run('upload-plan.mjs', '--dist', distDir, '--base', `${server!.url}/viceme-sdk/0.1.0/`),
    ).rejects.toMatchObject({ code: 1 });
    remote.delete('index.js');
  });

  it('guards manifest.json itself against overwrite', async () => {
    remote.set('manifest.json', {
      body: Buffer.from('{"version":"0.0.0-tampered"}\n'),
      contentType: 'application/json; charset=utf-8',
    });
    await expect(
      run('upload-plan.mjs', '--dist', distDir, '--base', `${server!.url}/viceme-sdk/0.1.0/`),
    ).rejects.toMatchObject({ code: 1 });
    remote.delete('manifest.json');
  });
});

/* --------------------------- dist-tag read-back -------------------------- */

describe('verify-npm-dist-tag.mjs', () => {
  function runJson(json: string, ...args: string[]) {
    return run('verify-npm-dist-tag.mjs', '--dist-tags-json', json, ...args);
  }

  it('passes when latest points at the stable version', async () => {
    const { stdout } = await runJson('{"latest":"0.2.0"}', '--version', '0.2.0', '--tag', 'latest');
    expect(stdout).toContain('latest -> 0.2.0');
  });

  it('fails when the tag is unset or points elsewhere', async () => {
    await expect(
      runJson('{"latest":"0.1.0"}', '--version', '0.2.0', '--tag', 'latest'),
    ).rejects.toMatchObject({ code: 1 });
    await expect(runJson('{}', '--version', '0.2.0', '--tag', 'latest')).rejects.toMatchObject({
      code: 1,
    });
  });

  it('rejects prerelease versions and non-latest tags', async () => {
    await expect(
      runJson('{"next":"0.2.0-next.0"}', '--version', '0.2.0-next.0', '--tag', 'next'),
    ).rejects.toMatchObject({ code: 2 });
  });
});

/* --------------------------- alias pointer write ------------------------- */

describe('write-alias-pointer.mjs', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'viceme-alias-'));

  // Fake region-scoped CDN: `fake-upload <region> <file> <key>` stores the
  // file under <root>/<region>/<key>; two static servers expose each region.
  const fakeUpload = join(tmpRoot, 'fake-upload.mjs');
  writeFileSync(
    fakeUpload,
    [
      "import { mkdirSync, copyFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      'const [, , region, file, key] = process.argv;',
      "const target = join(process.env.FAKE_CDN_ROOT ?? '', region, key);",
      'mkdirSync(dirname(target), { recursive: true });',
      'copyFileSync(file, target);',
    ].join('\n'),
  );

  function startRegionServer(region: string) {
    const regionRoot = join(tmpRoot, region);
    const httpServer: Server = createServer((req, res) => {
      const path = decodeURIComponent(req.url ?? '').replace(/^\/+/, '');
      try {
        const body = readFileSync(join(regionRoot, path));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address();
        if (address === null || typeof address === 'string') throw new Error('bind failed');
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () => new Promise((done) => httpServer.close(() => done())),
        });
      });
    });
  }

  it('writes one pointer object per region and verifies the read-back', async () => {
    const cn = await startRegionServer('cn');
    const global = await startRegionServer('global');
    try {
      const { stdout } = await exec(
        'node',
        [
          join(scriptsDir, 'write-alias-pointer.mjs'),
          '--version',
          '0.2.0',
          '--regions',
          'cn,global',
          '--hosts',
          `cn=${cn.url},global=${global.url}`,
          '--upload-command',
          `node ${fakeUpload}`,
        ],
        { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
      );
      expect(stdout).toContain('alias pointer written and verified in 2 region(s)');
      for (const region of ['cn', 'global']) {
        expect(readFileSync(join(tmpRoot, region, '-', 'aliases', 'v1'), 'utf8')).toBe('0.2.0');
      }
    } finally {
      await cn.close();
      await global.close();
    }
  });

  it('fails closed when the pointer never converges (bounded wait)', async () => {
    const cn = await startRegionServer('cn');
    try {
      // Pre-seed a wrong pointer and make the upload a no-op; a tiny
      // convergence budget keeps the test fast.
      mkdirSync(join(tmpRoot, 'cn', 'sdk', '-', 'aliases'), { recursive: true });
      writeFileSync(join(tmpRoot, 'cn', '-', 'aliases', 'v1'), '9.9.9');
      await expect(
        exec(
          'node',
          [
            join(scriptsDir, 'write-alias-pointer.mjs'),
            '--version',
            '0.2.0',
            '--regions',
            'cn',
            '--hosts',
            `cn=${cn.url}`,
            '--upload-command',
            'true',
            '--converge-timeout-ms',
            '2500',
          ],
          { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
        ),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await cn.close();
    }
  });

  it(
    'converges after a stale edge stops serving the old pointer',
    { timeout: 25_000 },
    async () => {
      // The "edge" serves the stale value for the first two reads, then the
      // origin value — the bounded poll must succeed without a purge.
      const cn = await startRegionServer('cn');
      let reads = 0;
      const stale = Buffer.from('0.1.0');
      const fresh = Buffer.from('0.2.0');
      const serverWithStaleEdge = {
        url: '',
        close: () => Promise.resolve(),
      };
      const httpServer: Server = createServer((_req, res) => {
        reads += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(reads <= 2 ? stale : fresh);
      });
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (address === null || typeof address === 'string') throw new Error('bind failed');
      serverWithStaleEdge.url = `http://127.0.0.1:${address.port}`;
      serverWithStaleEdge.close = () => new Promise<void>((done) => httpServer.close(() => done()));
      void cn; // region server unused here; keep structure symmetric
      try {
        const { stdout } = await exec(
          'node',
          [
            join(scriptsDir, 'write-alias-pointer.mjs'),
            '--version',
            '0.2.0',
            '--regions',
            'cn',
            '--hosts',
            `cn=${serverWithStaleEdge.url}`,
            '--upload-command',
            'true',
            '--converge-timeout-ms',
            '15000',
          ],
          { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
        );
        expect(stdout).toContain('alias pointer written and verified in 1 region(s)');
      } finally {
        await serverWithStaleEdge.close();
      }
    },
  );

  it('runs the purge hook after each pointer write', async () => {
    const purgeMarker = join(tmpRoot, 'purge-invoked');
    const fakePurge = join(tmpRoot, 'fake-purge.mjs');
    writeFileSync(
      fakePurge,
      [
        "import { writeFileSync } from 'node:fs';",
        'const [, , region, key] = process.argv;',
        "writeFileSync(process.env.PURGE_MARKER ?? '', `${region} ${key}\\n`);",
      ].join('\n'),
    );
    // Isolate the pointer: earlier tests may have left a newer value, which
    // the promote policy would (correctly) refuse to move backward from.
    rmSync(join(tmpRoot, 'cn', '-', 'aliases', 'v1'), { force: true });
    const cn = await startRegionServer('cn');
    try {
      await exec(
        'node',
        [
          join(scriptsDir, 'write-alias-pointer.mjs'),
          '--version',
          '0.2.0',
          '--regions',
          'cn',
          '--hosts',
          `cn=${cn.url}`,
          '--upload-command',
          `node ${fakeUpload}`,
          '--purge-command',
          `node ${fakePurge}`,
        ],
        { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot, PURGE_MARKER: purgeMarker } },
      );
      expect(readFileSync(purgeMarker, 'utf8')).toBe('cn -/aliases/v1\n');
    } finally {
      await cn.close();
    }
  });

  it('rejects unknown regions', async () => {
    await expect(
      run(
        'write-alias-pointer.mjs',
        '--version',
        '0.2.0',
        '--regions',
        'eu',
        '--hosts',
        'eu=https://example.com',
        '--upload-command',
        'true',
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('promote refuses to move the pointer backward', async () => {
    const cn = await startRegionServer('cn');
    try {
      // Current pointer is NEWER than the target; upload is a no-op so a
      // policy bug could never silently "fix" the pointer.
      mkdirSync(join(tmpRoot, 'cn', 'sdk', '-', 'aliases'), { recursive: true });
      writeFileSync(join(tmpRoot, 'cn', '-', 'aliases', 'v1'), '0.3.0');
      const failure = await exec(
        'node',
        [
          join(scriptsDir, 'write-alias-pointer.mjs'),
          '--version',
          '0.2.0',
          '--regions',
          'cn',
          '--hosts',
          `cn=${cn.url}`,
          '--upload-command',
          'true',
          '--mode',
          'promote',
        ],
        { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
      ).catch((error: { code?: number; stderr?: string }) => error);
      expect(failure).toMatchObject({ code: 1 });
      expect(String((failure as { stderr?: string }).stderr)).toContain(
        'refusing to move pointer backward',
      );
      // Pointer untouched.
      expect(readFileSync(join(tmpRoot, 'cn', '-', 'aliases', 'v1'), 'utf8')).toBe('0.3.0');
    } finally {
      await cn.close();
    }
  });

  it('rollback requires the declared current pointer and moves backward', async () => {
    const cn = await startRegionServer('cn');
    try {
      mkdirSync(join(tmpRoot, 'cn', 'sdk', '-', 'aliases'), { recursive: true });
      writeFileSync(join(tmpRoot, 'cn', '-', 'aliases', 'v1'), '0.3.0');

      // Stale-job guard: the declared current does not match the live value.
      await expect(
        exec(
          'node',
          [
            join(scriptsDir, 'write-alias-pointer.mjs'),
            '--version',
            '0.2.0',
            '--regions',
            'cn',
            '--hosts',
            `cn=${cn.url}`,
            '--upload-command',
            `node ${fakeUpload}`,
            '--mode',
            'rollback',
            '--from-current',
            '0.4.0',
          ],
          { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
        ),
      ).rejects.toMatchObject({ code: 1 });

      // Authorized rollback: declared current matches; pointer moves back.
      const { stdout } = await exec(
        'node',
        [
          join(scriptsDir, 'write-alias-pointer.mjs'),
          '--version',
          '0.2.0',
          '--regions',
          'cn',
          '--hosts',
          `cn=${cn.url}`,
          '--upload-command',
          `node ${fakeUpload}`,
          '--mode',
          'rollback',
          '--from-current',
          '0.3.0',
        ],
        { env: { ...process.env, FAKE_CDN_ROOT: tmpRoot } },
      );
      expect(stdout).toContain('authorized rollback');
      expect(readFileSync(join(tmpRoot, 'cn', '-', 'aliases', 'v1'), 'utf8')).toBe('0.2.0');
    } finally {
      await cn.close();
    }
  });
});

/* ---------------------------- input validation --------------------------- */

describe('validate-release-inputs.mjs', () => {
  it('accepts exact semver versions and known region sets', async () => {
    await expect(run('validate-release-inputs.mjs', '--version', '1.2.3')).resolves.toMatchObject({
      stdout: expect.stringContaining('valid'),
    });
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', 'cn,global'),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('valid') });
  });

  it('rejects malformed versions and unknown or duplicate regions', async () => {
    for (const bad of ['1.2', 'v1.2.3', '1.2.3-next.0', '1.2.3;rm -rf', '../escape', '']) {
      await expect(run('validate-release-inputs.mjs', '--version', bad)).rejects.toMatchObject({
        code: 1,
      });
    }
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', 'eu'),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', 'cn,cn'),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      run('validate-release-inputs.mjs', '--version', '1.2.3', '--regions', ','),
    ).rejects.toMatchObject({ code: 1 });
  });
});
