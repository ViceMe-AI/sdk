#!/usr/bin/env node
/**
 * Local static server for Playwright loader tests.
 *
 * Reproduces the CDN layout (§14.3) against local build output:
 *
 *   /sdk/<version>/viceme.min.js  -> dist/viceme.min.js
 *   /sdk/v1/...                   -> same content (stable alias)
 *   any manifest.json             -> dist/manifest.json with the test-only
 *                                    fixture capability injected (the "local
 *                                    fixture manifest" — never shipped)
 *   any fixture.js                -> test-fixtures-dist/fixture.js
 *   /pages/...                    -> test pages
 *
 * The public API is never served here; Playwright route interception mocks it.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = join(here, '..', '..');
const distDir = join(sdkDir, 'dist');
const fixturesDist = join(sdkDir, 'test-fixtures-dist');
const pagesDir = join(here, 'pages');

const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
const manifestWithFixture = {
  ...manifest,
  features: { ...manifest.features, fixture: 'fixture.js' },
};

const MIME = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
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

    let file = null;
    if (path.startsWith('/pages/')) {
      file = join(pagesDir, normalize(path.slice('/pages/'.length)));
    } else if (/^\/sdk\/(v1|\d+\.\d+\.\d+[^/]*)\//.test(path)) {
      const rest = path.split('/').slice(3).join('/');
      if (rest === 'manifest.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(manifestWithFixture));
        return;
      }
      if (rest === 'fixture.js') {
        file = join(fixturesDist, 'fixture.js');
      } else {
        // Loader, core, and manifest all live at the dist root — the same
        // flat public layout the CDN serves.
        file = join(distDir, rest);
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
