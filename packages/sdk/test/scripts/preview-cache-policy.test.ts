// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { previewCacheControl } from '../../../../scripts/lib/preview-cache-policy.mjs';

describe('previewCacheControl', () => {
  it('keeps mutable pointers uncached', () => {
    expect(previewCacheControl('/viceme-sdk/-/aliases/v1', '0.1.6')).toBe('no-store');
  });

  it('briefly caches the stable bootstrap', () => {
    expect(previewCacheControl('/viceme-sdk/v1/viceme.min.js', '0.1.6')).toBe('public,max-age=300');
  });

  it('marks exact release artifacts immutable', () => {
    expect(previewCacheControl('/viceme-sdk/0.1.6/danmaku.js', '0.1.6')).toBe(
      'public,max-age=31536000,immutable',
    );
  });
});
