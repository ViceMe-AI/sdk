import { afterEach, describe, expect, it } from 'vitest';

import { readDanmakuPageAnchor } from '../../../src/danmaku/anchor.ts';

afterEach(() => {
  document.head.querySelector('link[rel="canonical"]')?.remove();
  window.history.replaceState(null, '', '/');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 0 });
});

describe('readDanmakuPageAnchor', () => {
  it('changes with hash navigation but never exposes the URL', () => {
    window.history.replaceState(null, '', '/game?token=secret#/level/1');
    const first = readDanmakuPageAnchor();
    window.history.pushState(null, '', '/game?token=secret#/level/2');
    const second = readDanmakuPageAnchor();

    expect(second.anchorKey).not.toBe(first.anchorKey);
    expect(second.anchorKey).toMatch(/^page:[a-z0-9]{14,16}:scroll:/);
    expect(second.anchorKey).not.toContain('secret');
    expect(second.anchorKey).not.toContain('/game');
  });

  it('uses the canonical URL when the page declares one', () => {
    const canonical = document.createElement('link');
    canonical.rel = 'canonical';
    canonical.href = '/article/canonical';
    document.head.appendChild(canonical);
    window.history.replaceState(null, '', '/article/alias');
    const fromAlias = readDanmakuPageAnchor();
    window.history.replaceState(null, '', '/article/another-alias');

    expect(readDanmakuPageAnchor().anchorKey).toBe(fromAlias.anchorKey);
  });

  it('keeps SPA hash routes when the canonical URL has no hash', () => {
    const canonical = document.createElement('link');
    canonical.rel = 'canonical';
    canonical.href = '/game';
    document.head.appendChild(canonical);
    window.history.replaceState(null, '', '/game#/level/1');
    const first = readDanmakuPageAnchor();
    window.history.pushState(null, '', '/game#/level/2');

    expect(readDanmakuPageAnchor().anchorKey).not.toBe(first.anchorKey);
  });

  it('groups a scrollable page into 10% buckets', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2_000,
    });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    expect(readDanmakuPageAnchor().scrollBucket).toBe('0-10');

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 1_200 });
    expect(readDanmakuPageAnchor().scrollBucket).toBe('90-100');
  });

  it('uses one bucket for pages that do not scroll', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 600,
    });
    expect(readDanmakuPageAnchor().scrollBucket).toBe('0-100');
  });
});
