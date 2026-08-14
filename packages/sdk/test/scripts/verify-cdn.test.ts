// @vitest-environment node
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', '..', '..', '..', 'scripts', 'verify-cdn.mjs');
const distDir = join(here, '..', '..', 'dist');

/**
 * CDN read-back verification tests: the script is run as a real subprocess
 * against a local server that mimics the CDN's immutable exact-version
 * semantics (content-type, cache-control, CORS), plus tamper detection and
 * alias expectation checks.
 */

interface ServedFile {
  body: Buffer;
  contentType: string;
}

function startCdnServer(files: Map<string, ServedFile>): Promise<{
  url: string;
  close: () => Promise<void>;
  setPrefix: (prefix: string) => void;
}> {
  const server: Server = createServer(async (req, res) => {
    // Both /sdk/<version>/ and /sdk/v1/ map to the same dist layout.
    const path = decodeURIComponent((req.url ?? '').replace(/^\/sdk\/[^/]+\//, ''));
    const file = files.get(path);
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('bind failed');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
        setPrefix: () => {},
      });
    });
  });
}

async function loadDistFiles(): Promise<Map<string, ServedFile>> {
  const files = new Map<string, ServedFile>();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, `${rel}/`);
      } else {
        files.set(rel, {
          body: await readFile(full),
          contentType: rel.endsWith('.json')
            ? 'application/json; charset=utf-8'
            : 'text/javascript; charset=utf-8',
        });
      }
    }
  };
  await walk(distDir, '');
  return files;
}

let server: Awaited<ReturnType<typeof startCdnServer>>;
let files: Map<string, ServedFile>;

beforeAll(async () => {
  files = await loadDistFiles();
  server = await startCdnServer(files);
});

afterAll(async () => {
  await server.close();
});

function run(...args: string[]) {
  return exec('node', [script, ...args]);
}

describe('verify-cdn.mjs', () => {
  it('passes for an untampered immutable exact version', async () => {
    const { stdout } = await run('--base', `${server.url}/sdk/0.1.0/`);
    expect(stdout).toContain('cdn verification passed');
  });

  it('detects a tampered artifact', async () => {
    const entry = files.get('index.js')!;
    const original = entry.body;
    // Flip one byte of index.js.
    const tampered = Buffer.from(original);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0xff;
    files.set('index.js', { ...entry, body: tampered });
    try {
      await expect(run('--base', `${server.url}/sdk/0.1.0/`)).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      files.set('index.js', { ...entry, body: original });
    }
  });

  it('enforces the alias expectation', async () => {
    await expect(
      run('--base', `${server.url}/sdk/v1/`, '--expect-version', '0.1.0', '--allow-mutable-cache'),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('0.1.0') });

    await expect(
      run('--base', `${server.url}/sdk/v1/`, '--expect-version', '9.9.9', '--allow-mutable-cache'),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('local mode verifies the build directory', async () => {
    const { stdout } = await run('--local', distDir);
    expect(stdout).toContain('local verification passed');
  });
});
