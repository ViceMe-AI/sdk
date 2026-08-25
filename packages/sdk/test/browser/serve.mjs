#!/usr/bin/env node
/**
 * Local static server for Playwright loader tests.
 *
 * `/viceme-sdk/v1/*` mirrors Shop's runtime proxy: it serves the immutable
 * release manifest, loader, danmaku entry, and referenced chunks directly.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = join(here, '..', '..');
const distDir = join(sdkDir, 'dist');
const pagesDir = join(here, 'pages');
const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
const SDK_CHUNK_PATH = /^chunks\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.js$/;
const SDK_ENTRY_PATHS = new Set(['manifest.json', 'viceme.min.js', 'danmaku.js']);

const MIME = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

const port = Number(process.env.PORT || 4173);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = decodeURIComponent(url.pathname);

    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (path === '/viceme-sdk/-/aliases/v1') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(manifest.version);
      return;
    }

    let file = null;
    if (path.startsWith('/pages/')) {
      file = join(pagesDir, normalize(path.slice('/pages/'.length)));
    } else if (/^\/viceme-sdk\/(v1|\d+\.\d+\.\d+[^/]*)\//.test(path)) {
      const rest = path.split('/').slice(3).join('/');
      if (SDK_ENTRY_PATHS.has(rest) || SDK_CHUNK_PATH.test(rest)) {
        file = join(distDir, normalize(rest));
      }
    }

    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'content-type':
        MIME.get(/^.*(\.[a-z]+)$/.exec(file)?.[1] ?? '') ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`sdk test server on http://127.0.0.1:${port}`);
});
