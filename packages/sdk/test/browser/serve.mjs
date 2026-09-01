#!/usr/bin/env node
/**
 * Local static server for Playwright loader tests.
 *
 * Port 4173 serves third-party host pages. Port 4174 serves the immutable
 * exact-version S3 artifacts cross-origin.
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
const EXACT_SDK_ENTRY_PATHS = new Set(['manifest.json', ...Object.keys(manifest.files)]);

const MIME = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

const pagePort = Number(process.env.PORT || 4173);
const s3Port = Number(process.env.S3_PORT || 4174);
const s3Origin = `http://127.0.0.1:${s3Port}`;
const exactSdkPrefix = `/viceme-sdk/${manifest.version}/`;
const exactLoaderUrl = `${s3Origin}${exactSdkPrefix}viceme.min.js`;

async function serve(req, res, topology) {
  try {
    const port = topology === 'page' ? pagePort : s3Port;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = decodeURIComponent(url.pathname);

    if (topology === 'page' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    let file = null;
    if (topology === 'page' && path.startsWith('/pages/')) {
      file = join(pagesDir, normalize(path.slice('/pages/'.length)));
    } else if (topology === 's3' && path.startsWith(exactSdkPrefix)) {
      const rest = path.slice(exactSdkPrefix.length);
      if (EXACT_SDK_ENTRY_PATHS.has(rest)) {
        file = join(distDir, normalize(rest));
      }
    }

    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    let body = await readFile(file);
    if (topology === 'page' && file.endsWith('.html')) {
      body = Buffer.from(
        body
          .toString('utf8')
          .replaceAll('__VICEME_S3_ORIGIN__', s3Origin)
          .replaceAll('__VICEME_SDK_LOADER_URL__', exactLoaderUrl),
      );
    }
    res.writeHead(200, {
      'content-type':
        MIME.get(/^.*(\.[a-z]+)$/.exec(file)?.[1] ?? '') ?? 'application/octet-stream',
      ...(topology === 's3' ? { 'access-control-allow-origin': '*' } : {}),
      'cache-control': topology === 's3' ? 'public,max-age=31536000,immutable' : 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

function listen(port, topology) {
  return new Promise((resolve) => {
    createServer((req, res) => serve(req, res, topology)).listen(port, '127.0.0.1', resolve);
  });
}

await Promise.all([listen(pagePort, 'page'), listen(s3Port, 's3')]);
console.log(`sdk test servers on http://127.0.0.1:${pagePort} and ${s3Origin}`);
