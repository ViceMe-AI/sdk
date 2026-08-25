import { expect, test, type Frame, type Page, type Route } from '@playwright/test';

import { SDK_VERSION } from '../../src/version.ts';

const DANMAKU_WIDGET_ORIGIN = (
  process.env.VICEME_BUILD_CN_WIDGET_ORIGIN ?? 'https://viceme.cn'
).replace(/\/+$/, '');

interface RecordedEvent {
  type: string;
  detail: Record<string, unknown>;
}

function cfgUrl(attrs: Record<string, string>, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  params.set('cfg', encodeURIComponent(JSON.stringify({ attrs })));
  return `/pages/loader-dynamic.html?${params.toString()}`;
}

const VALID_ATTRS: Record<string, string> = {
  'data-viceme-work': 'wrk_test',
  'data-viceme-region': 'cn',
  'data-viceme-features': 'danmaku',
  'data-viceme-target': '#host-a',
};

async function waitForEvent(page: Page, type: string, count = 1): Promise<RecordedEvent[]> {
  await page.waitForFunction(
    ({ eventType, eventCount }) => {
      const events = (window as { __events?: { type: string }[] }).__events ?? [];
      return events.filter((event) => event.type === eventType).length >= eventCount;
    },
    { eventType: type, eventCount: count },
  );
  return page.evaluate(() => (window as unknown as { __events: RecordedEvent[] }).__events);
}

async function mockHostedDanmaku(page: Page) {
  let hits = 0;
  await page.route(`${DANMAKU_WIDGET_ORIGIN}/embed/danmaku**`, async (route: Route) => {
    hits += 1;
    const url = new URL(route.request().url());
    const mode = url.searchParams.get('mode') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html><body data-mode="${mode}">
          <button id="open" type="button">open</button>
          <script>
            document.body.dataset.reducedMotion = String(
              matchMedia('(prefers-reduced-motion: reduce)').matches,
            );
            window.addEventListener('message', (event) => {
              if (event.data?.source !== 'viceme-danmaku') return;
              if (event.data.action === 'anchor-change') {
                document.body.dataset.anchor = event.data.anchorKey;
              }
            });
            document.querySelector('#open').addEventListener('click', () => {
              parent.postMessage({ source: 'viceme-danmaku', action: 'open-modal' }, '*');
            });
            window.addEventListener('keydown', (event) => {
              if (event.key === 'Escape') {
                parent.postMessage({ source: 'viceme-danmaku', action: 'close-modal' }, '*');
              }
            });
            parent.postMessage({ source: 'viceme-danmaku', action: 'request-anchor' }, '*');
          </script>
        </body></html>`,
    });
  });
  return {
    get hits() {
      return hits;
    },
  };
}

function recordRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  return requests;
}

function frameMode(frame: Frame): string | null {
  return new URL(frame.url(), 'http://localhost').searchParams.get('mode');
}

async function waitForFrameMode(page: Page, mode: string): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frameMode(frame) === mode)).toBe(true);
  return page.frames().find((frame) => frameMode(frame) === mode)!;
}

function expectNoRemovedApiRequests(requests: string[]): void {
  expect(
    requests.filter((url) =>
      /work-sessions|\/v1\/public\/v1\/(auth|access|checkout|follow)/.test(url),
    ),
  ).toEqual([]);
}

test.describe('PUBLIC-only hosted danmaku loader', () => {
  test('static script mounts three isolated frames without an SDK Session', async ({ page }) => {
    const requests = recordRequests(page);
    const hosted = await mockHostedDanmaku(page);
    await page.goto('/pages/loader-static.html#/chapter/1');

    const events = await waitForEvent(page, 'viceme:ready');
    expect(events.find((event) => event.type === 'viceme:ready')?.detail).toMatchObject({
      clientKey: 'v1+cn+wrk_test',
      workKey: 'wrk_test',
      capabilities: ['danmaku'],
      version: SDK_VERSION,
    });
    expect(
      events.find((event) => event.type === 'viceme:capability-ready')?.detail.capability,
    ).toBe('danmaku');

    const mounted = await page.evaluate(() => {
      const portal = document.querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')!;
      const frames = Array.from(portal.shadowRoot!.querySelectorAll<HTMLIFrameElement>('iframe'));
      return {
        frameCount: frames.length,
        stagePointerEvents: frames[0]?.style.pointerEvents,
        controlsPointerEvents: frames[1]?.style.pointerEvents,
        modalSource: frames[2]?.getAttribute('src'),
        shadowRoot: !!portal.shadowRoot,
      };
    });
    expect(mounted).toEqual({
      frameCount: 3,
      stagePointerEvents: 'none',
      controlsPointerEvents: 'auto',
      modalSource: 'about:blank',
      shadowRoot: true,
    });
    await expect.poll(() => hosted.hits).toBe(2);

    await page.locator('#host-action').click();
    await expect(page.locator('#host-status')).toHaveText('clicked');
    expectNoRemovedApiRequests(requests);
  });

  test('dynamic insertion uses manifest.json, danmaku.js, and proxy-allowed chunks only', async ({
    page,
  }) => {
    const requests = recordRequests(page);
    await mockHostedDanmaku(page);
    await page.goto(cfgUrl(VALID_ATTRS));
    await waitForEvent(page, 'viceme:ready');

    const runtimePaths = requests
      .map((url) => new URL(url).pathname)
      .filter((path) => path.startsWith('/viceme-sdk/v1/'));
    expect(runtimePaths).toContain('/viceme-sdk/v1/manifest.json');
    expect(runtimePaths).toContain('/viceme-sdk/v1/danmaku.js');
    expect(runtimePaths).not.toContain('/viceme-sdk/v1/index.js');
    for (const path of runtimePaths) {
      expect(path).toMatch(
        /^\/viceme-sdk\/v1\/(?:viceme\.min\.js|manifest\.json|danmaku\.js|chunks\/[a-zA-Z0-9._-]+\.js)$/,
      );
    }
    expectNoRemovedApiRequests(requests);
  });

  test('falls back from a CDN alias manifest to the exact-version manifest', async ({ page }) => {
    await mockHostedDanmaku(page);
    await page.route('**/viceme-sdk/v1/manifest.json', (route) => route.fulfill({ status: 404 }));
    await page.goto(cfgUrl(VALID_ATTRS));

    const events = await waitForEvent(page, 'viceme:ready');
    expect(events.find((event) => event.type === 'viceme:ready')?.detail.version).toBe(SDK_VERSION);
  });
});

test.describe('attribute validation fails closed', () => {
  const cases: Array<{ name: string; attrs: Record<string, string> }> = [
    { name: 'missing work', attrs: { ...VALID_ATTRS, 'data-viceme-work': '' } },
    { name: 'invalid region', attrs: { ...VALID_ATTRS, 'data-viceme-region': 'eu' } },
    { name: 'missing feature', attrs: { ...VALID_ATTRS, 'data-viceme-features': '' } },
    { name: 'unknown feature', attrs: { ...VALID_ATTRS, 'data-viceme-features': 'fixture' } },
    {
      name: 'mixed feature list',
      attrs: { ...VALID_ATTRS, 'data-viceme-features': 'danmaku,checkout' },
    },
    { name: 'unknown attribute', attrs: { ...VALID_ATTRS, 'data-viceme-token': 'nope' } },
    {
      name: 'missing target',
      attrs: {
        'data-viceme-work': 'wrk_test',
        'data-viceme-region': 'cn',
        'data-viceme-features': 'danmaku',
      },
    },
    { name: 'target matches nothing', attrs: { ...VALID_ATTRS, 'data-viceme-target': '#nope' } },
    { name: 'target matches multiple', attrs: { ...VALID_ATTRS, 'data-viceme-target': '.multi' } },
    {
      name: 'invalid target selector',
      attrs: { ...VALID_ATTRS, 'data-viceme-target': '#host[' },
    },
  ];

  for (const { name, attrs } of cases) {
    test(name, async ({ page }) => {
      const hosted = await mockHostedDanmaku(page);
      await page.goto(cfgUrl(attrs));
      const events = await waitForEvent(page, 'viceme:error');
      const error = events.find((event) => event.type === 'viceme:error')!;
      expect(error.detail).toMatchObject({ code: 'CONFIG_INVALID', retryable: false });
      expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(0);
      expect(hosted.hits).toBe(0);
    });
  }
});

test.describe('deduplication and namespace lifecycle', () => {
  test('identical scripts share one local client and one mount', async ({ page }) => {
    const hosted = await mockHostedDanmaku(page);
    const params = new URLSearchParams();
    params.set('cfg', encodeURIComponent(JSON.stringify({ scripts: [VALID_ATTRS, VALID_ATTRS] })));
    await page.goto(`/pages/loader-dynamic.html?${params.toString()}`);
    await waitForEvent(page, 'viceme:ready');
    await expect.poll(() => hosted.hits).toBe(2);

    const state = await page.evaluate(() => {
      const events = (window as unknown as { __events: RecordedEvent[] }).__events;
      return {
        portals: document.querySelectorAll('[data-viceme-danmaku="mounted"]').length,
        ready: events.filter((event) => event.type === 'viceme:ready').length,
        capabilityReady: events.filter((event) => event.type === 'viceme:capability-ready').length,
      };
    });
    expect(state).toEqual({ portals: 1, ready: 1, capabilityReady: 1 });
  });

  test('same work on distinct targets shares the client and mounts twice', async ({ page }) => {
    const hosted = await mockHostedDanmaku(page);
    const params = new URLSearchParams();
    params.set(
      'cfg',
      encodeURIComponent(
        JSON.stringify({
          scripts: [VALID_ATTRS, { ...VALID_ATTRS, 'data-viceme-target': '#host-b' }],
        }),
      ),
    );
    await page.goto(`/pages/loader-dynamic.html?${params.toString()}`);
    await waitForEvent(page, 'viceme:capability-ready', 2);

    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(2);
    await expect.poll(() => hosted.hits).toBe(4);
  });

  test('v1 and v2 namespaces coexist', async ({ page }) => {
    await mockHostedDanmaku(page);
    await page.goto(cfgUrl(VALID_ATTRS, { presetV2: '1' }));
    await waitForEvent(page, 'viceme:ready');

    const state = await page.evaluate(() => {
      const versions = (window as { ViceMe?: { versions: Record<string, unknown> } }).ViceMe!
        .versions;
      return { majors: Object.getOwnPropertyNames(versions).sort(), v2: versions.v2 };
    });
    expect(state.majors).toEqual(['v1', 'v2']);
    expect((state.v2 as { marker?: string }).marker).toBe('keep-me');
  });

  test('a danmaku chunk failure degrades the local client without touching the host', async ({
    page,
  }) => {
    await page.route('**/viceme-sdk/*/danmaku.js', (route) =>
      route.fulfill({ status: 404, body: '' }),
    );
    await page.goto(cfgUrl(VALID_ATTRS));
    const events = await waitForEvent(page, 'viceme:error');
    expect(events.find((event) => event.type === 'viceme:error')?.detail).toMatchObject({
      code: 'INTERNAL_ERROR',
      capability: 'danmaku',
    });
    await page.locator('#host-action').click();
    await expect(page.locator('#status')).toHaveText('clicked');

    const clientState = await page.evaluate(async () => {
      const namespace = (
        window as unknown as {
          ViceMe: { versions: { v1: { whenReady(key: string): Promise<{ state: string }> } } };
        }
      ).ViceMe.versions.v1;
      return (await namespace.whenReady('v1+cn+wrk_test')).state;
    });
    expect(clientState).toBe('DEGRADED');
  });

  test('destroy removes all portals and permits a fresh mount', async ({ page }) => {
    const hosted = await mockHostedDanmaku(page);
    await page.goto(cfgUrl(VALID_ATTRS));
    await waitForEvent(page, 'viceme:ready');

    await page.evaluate(() => {
      const namespace = (
        window as unknown as {
          ViceMe: { versions: { v1: { destroyClient(key: string): void } } };
        }
      ).ViceMe.versions.v1;
      namespace.destroyClient('v1+cn+wrk_test');
    });
    await waitForEvent(page, 'viceme:destroyed');
    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(0);

    await page.evaluate(() => {
      const script = document.createElement('script');
      script.src = '/viceme-sdk/v1/viceme.min.js';
      script.setAttribute('data-viceme-work', 'wrk_test');
      script.setAttribute('data-viceme-region', 'cn');
      script.setAttribute('data-viceme-features', 'danmaku');
      script.setAttribute('data-viceme-target', '#host-a');
      document.body.append(script);
    });
    await waitForEvent(page, 'viceme:ready', 2);
    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(1);
    await expect.poll(() => hosted.hits).toBe(4);
  });
});

test.describe('host interaction, anchors, and hosted accessibility boundary', () => {
  test('stage preserves clicks and updates opaque anchors on scroll and SPA navigation', async ({
    page,
  }) => {
    await mockHostedDanmaku(page);
    await page.goto('/pages/loader-static.html?private=secret#/chapter/1');
    await waitForEvent(page, 'viceme:ready');

    const stage = await waitForFrameMode(page, 'stage');
    await expect(stage.locator('body')).toHaveAttribute('data-anchor', /:scroll:0-10$/);
    expect(stage.url()).not.toContain('secret');

    await page.locator('#host-action').click();
    await expect(page.locator('#host-status')).toHaveText('clicked');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(stage.locator('body')).toHaveAttribute('data-anchor', /:scroll:90-100$/);

    const beforeNavigation = await stage.locator('body').getAttribute('data-anchor');
    await page.evaluate(() => window.history.pushState(null, '', '/next#/chapter/2'));
    await expect
      .poll(() => stage.locator('body').getAttribute('data-anchor'))
      .not.toBe(beforeNavigation);
  });

  test('keeps modal lazy, inherits reduced motion, and closes on hosted Escape handling', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const hosted = await mockHostedDanmaku(page);
    await page.goto('/pages/loader-static.html');
    await waitForEvent(page, 'viceme:ready');
    await expect.poll(() => hosted.hits).toBe(2);

    const controls = await waitForFrameMode(page, 'controls');
    await expect(controls.locator('body')).toHaveAttribute('data-reduced-motion', 'true');
    await controls.locator('#open').click();
    await expect.poll(() => hosted.hits).toBe(3);

    const modal = await waitForFrameMode(page, 'modal');
    const modalElement = page.locator('[data-viceme-danmaku="mounted"] iframe[data-mode="modal"]');
    await expect(modalElement).toHaveCSS('display', 'block');
    await modal.locator('body').press('Escape');
    await expect(modalElement).toHaveCSS('display', 'none');
  });

  test('writes no storage, cookies, or global CSS', async ({ page }) => {
    await mockHostedDanmaku(page);
    await page.goto(cfgUrl(VALID_ATTRS, { hostileCss: '1' }));
    await waitForEvent(page, 'viceme:ready');

    const state = await page.evaluate(() => ({
      localStorage: window.localStorage.length,
      cookie: document.cookie,
      styleSheets: document.styleSheets.length,
      portalShadow: !!document.querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]')
        ?.shadowRoot,
    }));
    expect(state).toEqual({ localStorage: 0, cookie: '', styleSheets: 2, portalShadow: true });
  });
});
