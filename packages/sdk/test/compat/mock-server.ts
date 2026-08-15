/**
 * Local mock public API for transport compatibility tests.
 *
 * Serves the baseline contract snapshot shapes over real HTTP (a plain node
 * server) so the FetchTransport is exercised end-to-end: CORS preflight,
 * status mapping, error bodies, request-id echo, unknown-field tolerance, and
 * failure modes (delay/abort/hang). Not used by browser tests — those mock at
 * the Playwright network layer.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

export interface MockResponder {
  json(status: number, body: unknown, headers?: Record<string, string>): void;
}

export interface MockApiServer {
  url: string;
  seen: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, unknown>;
    body: unknown;
  }>;
  close(): Promise<void>;
}

export type MockHandler = (
  req: IncomingMessage,
  body: unknown,
  res: MockResponder,
) => void | Promise<void>;

export function startMockApiServer(
  options: { handler?: MockHandler } = {},
): Promise<MockApiServer> {
  const seen: MockApiServer['seen'] = [];
  const handler: MockHandler = options.handler ?? defaultHandler;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body: unknown = rawBody ? JSON.parse(rawBody) : undefined;

    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers as Record<string, unknown>,
      body,
    });

    const cors: Record<string, string> = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-client-request-id',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const responder: MockResponder = {
      json(status: number, payload: unknown, headers: Record<string, string> = {}) {
        res.writeHead(status, { ...cors, 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      },
    };

    try {
      await handler(req, body, responder);
    } catch (error) {
      responder.json(500, { error: { code: 'INTERNAL_ERROR', message: String(error) } });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('mock server failed to bind');
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        seen,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function defaultHandler(req: IncomingMessage, body: unknown, res: MockResponder): void {
  if (req.url === '/public/v1/work-sessions' && req.method === 'POST') {
    res.json(
      201,
      {
        work: {
          key: (body as { workKey?: unknown } | undefined)?.workKey,
          capabilities: ['fixture'],
        },
        token: 'test-token',
        unknownFutureField: { tolerated: true },
      },
      { 'x-request-id': 'srv-mock-1' },
    );
    return;
  }
  res.json(404, { error: { code: 'CONFIG_INVALID', message: 'no fixture' } });
}
