#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(rootDir, 'packages', 'sdk', 'dist');
const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
const allowedFiles = new Set(['manifest.json', ...Object.keys(manifest.files)]);
const port = Number(process.env.PORT || 8080);

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-type': contentType,
    'cross-origin-resource-policy': 'cross-origin',
  });
  response.end(body);
}

createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'method not allowed');
      return;
    }

    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/healthz') {
      send(response, 200, 'ok');
      return;
    }
    if (url.pathname === '/viceme-sdk/-/aliases/v1') {
      send(response, 200, version);
      return;
    }

    let fileName;
    if (url.pathname === '/viceme-sdk/v1/viceme.min.js') {
      fileName = 'bootstrap.min.js';
    } else {
      const prefix = `/viceme-sdk/${version}/`;
      if (!url.pathname.startsWith(prefix)) {
        send(response, 404, 'not found');
        return;
      }
      fileName = decodeURIComponent(url.pathname.slice(prefix.length));
      if (!allowedFiles.has(fileName)) {
        send(response, 404, 'not found');
        return;
      }
    }

    const body = await readFile(join(distDir, fileName));
    send(
      response,
      200,
      request.method === 'HEAD' ? undefined : body,
      contentTypes.get(extname(fileName)) ?? 'application/octet-stream',
    );
  } catch {
    send(response, 404, 'not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`ViceMe SDK preview listening on :${port}`);
});
