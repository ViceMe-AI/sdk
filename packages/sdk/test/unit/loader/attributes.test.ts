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
  'data-viceme-features': 'fixture',
  'data-viceme-target': '#host',
};

describe('parseLoaderAttributes', () => {
  it('parses the valid shape with defaults', () => {
    const attrs = parseLoaderAttributes(script(VALID));
    expect(attrs).toMatchObject({
      workKey: 'wrk_test',
      region: 'cn',
      features: ['fixture'],
      target: '#host',
      theme: 'auto',
    });
  });

  it('deduplicates and trims features preserving order', () => {
    const attrs = parseLoaderAttributes(
      script({ ...VALID, 'data-viceme-features': 'fixture, fixture ,other-thing' }),
    );
    expect(attrs.features).toEqual(['fixture', 'other-thing']);
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

  it('rejects invalid feature names', () => {
    expect(() =>
      parseLoaderAttributes(script({ ...VALID, 'data-viceme-features': 'Bad Name' })),
    ).toThrow();
  });

  it('requires a target when features are declared', () => {
    const { 'data-viceme-target': _t, ...noTarget } = VALID;
    void _t;
    expect(() => parseLoaderAttributes(script(noTarget))).toThrow();
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
