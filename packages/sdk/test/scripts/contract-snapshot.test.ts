// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../contracts/public-capabilities.openapi.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  security: unknown[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<
      string,
      {
        properties?: Record<string, unknown>;
        pattern?: string;
      }
    >;
  };
};

describe('Shop public contract snapshot', () => {
  it('contains creator access and public danmaku operations', () => {
    expect(snapshot.security).toEqual([]);
    expect(Object.keys(snapshot.paths)).toEqual(
      expect.arrayContaining([
        '/v1/public/v1/work-sessions',
        '/v1/public/v1/auth/wechat/authorize',
        '/v1/public/v1/follow',
        '/v1/public/v1/access/check',
        '/v1/public/v1/access/features',
        '/v1/public/v1/checkout/sessions',
        '/v1/danmaku/messages',
      ]),
    );
    expect(Object.keys(snapshot.paths['/v1/danmaku/messages']!).sort()).toEqual(['get', 'post']);
  });

  it('keeps anonymous identity out of create and message payloads', () => {
    const schemas = snapshot.components.schemas;
    expect(Object.keys(schemas.CreateDanmakuMessageRequest?.properties ?? {}).sort()).toEqual([
      'anchorKey',
      'content',
      'workKey',
    ]);
    expect(Object.keys(schemas.DanmakuMessage?.properties ?? {}).sort()).toEqual([
      'anchorKey',
      'content',
      'createdAt',
      'id',
      'workKey',
    ]);
    expect(schemas.CreateDanmakuMessageRequest?.properties).not.toHaveProperty('authorName');
    expect(schemas.DanmakuMessage?.properties).not.toHaveProperty('authorName');
  });

  it('matches the Shop cursor contract', () => {
    const schemas = snapshot.components.schemas;
    expect(schemas.DanmakuCursor?.pattern).toBe(
      '^[0-9a-z]+\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    );
  });
});
