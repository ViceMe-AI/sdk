import { describe, expect, it } from 'vitest';
import { parseLoaderAttributes } from '../../../src/loader/attributes.ts';

function script(attrs: Record<string, string>): HTMLScriptElement {
  const el = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const VALID = {
  'data-viceme-work': 'wrk_test',
  'data-viceme-region': 'cn',
  'data-viceme-features': 'danmaku',
  'data-viceme-target': '#host',
};

describe('parseLoaderAttributes', () => {
  it('parses the valid shape with defaults', () => {
    const attrs = parseLoaderAttributes(script(VALID));
    expect(attrs).toMatchObject({
      workKey: 'wrk_test',
      region: 'cn',
      features: ['danmaku'],
      target: '#host',
      theme: 'auto',
    });
  });

  it.each([
    ['tip', ['tip']],
    ['danmaku,tip', ['danmaku', 'tip']],
    ['tip,danmaku', ['danmaku', 'tip']],
  ])('accepts and normalizes hosted feature declaration %s', (features, expected) => {
    expect(
      parseLoaderAttributes(script({ ...VALID, 'data-viceme-features': features })).features,
    ).toEqual(expected);
  });

  it.each([
    'fixture',
    'danmaku,ghost',
    'danmaku,danmaku',
    'tip,tip',
    ' danmaku ',
    'danmaku, tip',
    'danmaku,',
  ])('rejects invalid hosted feature declaration: %s', (features) => {
    expect(() =>
      parseLoaderAttributes(script({ ...VALID, 'data-viceme-features': features })),
    ).toThrow(/must contain each of "danmaku" and "tip" at most once/);
  });

  it('rejects unknown data-viceme-* attributes (no token smuggling)', () => {
    expect(() =>
      parseLoaderAttributes(script({ ...VALID, 'data-viceme-token': 'secret' })),
    ).toThrow(/Unknown loader attribute/);
  });

  it('rejects missing work / region / features', () => {
    expect(() => parseLoaderAttributes(script({ ...VALID, 'data-viceme-work': '' }))).toThrow();
    const { 'data-viceme-work': _w, ...noWork } = VALID;
    void _w;
    expect(() => parseLoaderAttributes(script(noWork))).toThrow();
    expect(() => parseLoaderAttributes(script({ ...VALID, 'data-viceme-region': 'eu' }))).toThrow();
    expect(() => parseLoaderAttributes(script({ ...VALID, 'data-viceme-features': '' }))).toThrow();
  });

  it('requires a target when features are declared', () => {
    const { 'data-viceme-target': _t, ...noTarget } = VALID;
    void _t;
    expect(() => parseLoaderAttributes(script(noTarget))).toThrow();
  });

  it('rejects an unparseable target selector as CONFIG_INVALID', () => {
    // `##bad` is rejected by both happy-dom and real browsers (`#host[` is
    // only rejected by real browsers — covered by the Playwright matrix).
    let error: unknown;
    try {
      parseLoaderAttributes(script({ ...VALID, 'data-viceme-target': '##bad' }));
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ code: 'CONFIG_INVALID', retryable: false });
  });

  it('validates theme values', () => {
    expect(() =>
      parseLoaderAttributes(script({ ...VALID, 'data-viceme-theme': 'neon' })),
    ).toThrow();
    expect(parseLoaderAttributes(script({ ...VALID, 'data-viceme-theme': 'dark' })).theme).toBe(
      'dark',
    );
  });
});
