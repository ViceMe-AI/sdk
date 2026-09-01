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
  it('contains only Website Access, danmaku, and read-only Tip config operations', () => {
    expect(snapshot.security).toEqual([]);
    expect(Object.keys(snapshot.paths).sort()).toEqual([
      '/v1/danmaku/messages',
      '/v1/public/work-sdk/access/check',
      '/v1/public/work-sdk/access/features',
      '/v1/public/work-sdk/checkout',
      '/v1/public/work-sdk/follow',
      '/v1/public/work-sdk/sessions',
      '/v1/work-sdk/{workKey}/tip-config',
    ]);
    expect(Object.keys(snapshot.paths['/v1/danmaku/messages']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(snapshot.paths['/v1/work-sdk/{workKey}/tip-config']!).sort()).toEqual([
      'get',
    ]);
    expect(
      (
        snapshot.paths['/v1/work-sdk/{workKey}/tip-config']?.get as {
          responses?: Record<string, unknown>;
        }
      ).responses,
    ).toHaveProperty('400.$ref', '#/components/responses/TipConfigCredentialsNotAllowed');
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

  it('snapshots only sanitized Tip configuration fields', () => {
    const schemas = snapshot.components.schemas;
    expect(schemas.WorkKey?.pattern).toBe('^wrk_[A-Za-z0-9_-]{4,124}$');
    expect(schemas.TipWorkKey?.pattern).toBe('^wrk_(?:test|live)_[A-Za-z0-9_-]{4,119}$');
    expect(Object.keys(schemas.TipConfig?.properties ?? {}).sort()).toEqual([
      'amount',
      'currency',
      'environment',
      'providers',
      'work',
      'workKey',
    ]);
    expect(Object.keys(schemas.TipWork?.properties ?? {}).sort()).toEqual(['id', 'title']);
    expect(Object.keys(schemas.TipAmount?.properties ?? {}).sort()).toEqual([
      'maxCents',
      'minCents',
      'stepCents',
    ]);
    expect(schemas.TipConfigCredentialsError?.properties).toMatchObject({
      code: { const: 'TIP_CONFIG_CREDENTIALS_NOT_ALLOWED' },
      statusCode: { const: 400 },
    });
    expect(JSON.stringify(schemas.TipConfig)).not.toMatch(
      /orderNo|token|paymentAction|transactionId|scene|metadata/i,
    );
  });
});
