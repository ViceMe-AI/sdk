import { expect, test, type Frame, type Page, type Route } from '@playwright/test';

import { API_MAJOR, SDK_VERSION } from '../../src/version.ts';

const DANMAKU_WIDGET_ORIGIN = (
  process.env.VICEME_BUILD_CN_WIDGET_ORIGIN ?? 'https://viceme.cn'
).replace(/\/+$/, '');
const S3_ALIAS_ORIGIN = `http://127.0.0.1:${process.env.S3_PORT ?? 4174}`;

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

interface HostedApiRequest {
  frameIsMain: boolean;
  headers: Record<string, string>;
  method: string;
  postData: string | null;
  url: string;
}

interface HostedDanmakuOptions {
  behavior?: 'ready' | 'no-ready' | 'network-error' | 'http-500';
  readyDelayMs?: number;
  skipReadyModes?: string[];
}

async function mockHostedDanmaku(page: Page, options: HostedDanmakuOptions = {}) {
  let hits = 0;
  const apiRequests: HostedApiRequest[] = [];
  await page.route(`${DANMAKU_WIDGET_ORIGIN}/v1/danmaku/messages**`, async (route: Route) => {
    const request = route.request();
    apiRequests.push({
      frameIsMain: request.frame() === page.mainFrame(),
      headers: request.headers(),
      method: request.method(),
      postData: request.postData(),
      url: request.url(),
    });
    const post = request.method() === 'POST';
    await route.fulfill({
      status: post ? 201 : 200,
      contentType: 'application/json',
      body: post
        ? JSON.stringify({
            id: '00000000-0000-4000-8000-000000000001',
            workKey: 'wrk_test',
            content: 'hello',
            anchorKey: null,
            createdAt: '2026-08-25T00:00:00.000Z',
          })
        : JSON.stringify({ items: [], nextCursor: null, total: 0 }),
    });
  });
  await page.route(`${DANMAKU_WIDGET_ORIGIN}/embed/danmaku**`, async (route: Route) => {
    hits += 1;
    if (options.behavior === 'network-error') {
      await route.abort('connectionfailed');
      return;
    }
    if (options.behavior === 'http-500') {
      await route.fulfill({ status: 500, contentType: 'text/plain', body: 'failed' });
      return;
    }
    const url = new URL(route.request().url());
    const mode = url.searchParams.get('mode') ?? '';
    const frameToken = url.searchParams.get('frameToken');
    const sendsReady = options.behavior !== 'no-ready' && !options.skipReadyModes?.includes(mode);
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html><head><style>
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
          #controls { display: none; width: 100%; height: 100%; align-items: center; justify-content: center; gap: 8px; background: #1f1f21; }
          body[data-mode="controls"] #controls { display: flex; }
          body[data-state="collapsed"] #controls > :not(#expand) { display: none; }
          #expand { display: none; width: 32px; height: 32px; }
          body[data-state="collapsed"] #expand { display: block; }
          body[data-state="more"] { background: #2b2c2f; }
          button { min-width: 32px; min-height: 32px; }
        </style></head><body data-mode="${mode}">
          <div id="controls">
            <button id="open" type="button">open</button>
            <button id="interact" type="button">interact</button>
            <button id="collapse" type="button">collapse</button>
            <button id="expand" type="button">expand</button>
            <button id="more" type="button">more</button>
          </div>
          <script>
            const mode = ${JSON.stringify(mode)};
            const emit = (message) => parent.postMessage({ source: 'viceme-danmaku', ...message }, '*');
            const setState = (state) => {
              document.body.dataset.state = state;
              const sizes = {
                collapsed: { width: 32, height: 32 },
                expanded: { width: 480, height: 56 },
                more: { width: 352, height: 328 },
              };
              emit({ action: 'resize-controls', ...sizes[state] });
            };
            document.body.dataset.reducedMotion = String(
              matchMedia('(prefers-reduced-motion: reduce)').matches,
            );
            window.addEventListener('message', (event) => {
              if (event.data?.source !== 'viceme-danmaku') return;
              if (event.data.action === 'anchor-change') {
                document.body.dataset.anchor = event.data.anchorKey;
              }
            });
            document.querySelector('#open')?.addEventListener('click', () => {
              emit({ action: 'open-modal' });
            });
            document.querySelector('#interact')?.addEventListener('click', () => {
              document.body.dataset.interacted = 'true';
            });
            document.querySelector('#collapse')?.addEventListener('click', () => setState('collapsed'));
            document.querySelector('#expand')?.addEventListener('click', () => setState('expanded'));
            document.querySelector('#more')?.addEventListener('click', () => {
              setState(document.body.dataset.state === 'more' ? 'expanded' : 'more');
            });
            window.addEventListener('keydown', (event) => {
              if (event.key === 'Escape') {
                emit({ action: 'close-modal' });
              }
            });
            emit({ action: 'request-anchor' });
            const announceReady = () => {
              if (mode === 'controls') setState('expanded');
              emit({
                action: 'frame-ready',
                mode,
                ...(mode === 'modal' ? { frameToken: ${JSON.stringify(frameToken)} } : {}),
              });
            };
            if (${JSON.stringify(sendsReady)}) {
              setTimeout(announceReady, ${JSON.stringify(options.readyDelayMs ?? 0)});
            }
            if (mode === 'stage') {
              Promise.allSettled([
                fetch('/v1/danmaku/messages?workKey=wrk_test&limit=1', { credentials: 'omit' }),
                fetch('/v1/danmaku/messages', {
                  method: 'POST',
                  credentials: 'omit',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ workKey: 'wrk_test', content: 'hello' }),
                }),
              ]).then(() => { document.body.dataset.apiComplete = 'true'; });
            }
          </script>
        </body></html>`,
    });
  });
  return {
    get hits() {
      return hits;
    },
    apiRequests,
  };
}

interface HostedTipOptions {
  ready?: boolean;
}

async function mockHostedTip(page: Page, options: HostedTipOptions = {}) {
  let hits = 0;
  const referers: string[] = [];
  await page.route(`${DANMAKU_WIDGET_ORIGIN}/widget/tip/wrk_test**`, async (route: Route) => {
    hits += 1;
    referers.push(route.request().headers().referer ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html><body>
          <button id="paid" type="button">paid</button>
          <button id="close" type="button">close</button>
          <script>
            const workId = '00000000-0000-4000-8000-000000000001';
            const emit = (message) => parent.postMessage(message, '*');
            if (${JSON.stringify(options.ready !== false)}) {
              emit({ type: 'viceme:widget-resize', workId, height: 360 });
            }
            document.querySelector('#paid').addEventListener('click', () => emit({
              type: 'viceme:tip-paid',
              workId,
              orderNo: 'VT20260827010203abcdef123456',
              status: 'PAID',
              amountCents: 520,
              accessToken: 'must-not-leak',
            }));
            document.querySelector('#close').addEventListener('click', () => emit({
              type: 'viceme:widget-close',
              workId,
              token: 'must-not-leak',
            }));
          </script>
        </body></html>`,
    });
  });
  return {
    get hits() {
      return hits;
    },
    referers,
  };
}

function releaseManifest(
  overrides: Partial<{ version: string; apiMajor: number; features: Record<string, string> }> = {},
): string {
  return JSON.stringify({
    version: SDK_VERSION,
    apiMajor: API_MAJOR,
    loader: 'viceme.min.js',
    features: { danmaku: 'danmaku.js', tip: 'tip.js' },
    ...overrides,
  });
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

async function expectFrameSize(
  locator: ReturnType<Page['locator']>,
  width: number,
  height: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box ? [Math.round(box.width), Math.round(box.height)] : null;
    })
    .toEqual([width, height]);
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
    const shopPaths = requests
      .filter((url) => new URL(url).origin === new URL(page.url()).origin)
      .map((url) => new URL(url).pathname);
    expect(shopPaths).toContain('/viceme-sdk/v1/viceme.min.js');
    expect(shopPaths).toContain('/viceme-sdk/v1/manifest.json');
    expect(shopPaths).toContain('/viceme-sdk/v1/danmaku.js');
    expect(shopPaths).not.toContain('/viceme-sdk/-/aliases/v1');
    expectNoRemovedApiRequests(requests);
  });

  test('the real v1 bootstrap preserves its CSP nonce and loads the exact release', async ({
    page,
  }) => {
    const styleCspErrors: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('Refused to apply inline style') || text.includes('style-src')) {
        styleCspErrors.push(text);
      }
    });
    const requests = recordRequests(page);
    await mockHostedDanmaku(page);
    await page.goto('/pages/bootstrap-nonce.html');

    await expect
      .poll(() =>
        page.evaluate((version) => {
          const loader = Array.from(document.scripts).find((script) =>
            script.src.endsWith(`/viceme-sdk/${version}/viceme.min.js`),
          );
          return loader?.nonce;
        }, SDK_VERSION),
      )
      .toBe('viceme-test');
    await waitForEvent(page, 'viceme:ready');

    const aliasRequests = requests.filter((url) => new URL(url).origin === S3_ALIAS_ORIGIN);
    const paths = aliasRequests.map((url) => new URL(url).pathname);
    expect(paths).toContain('/viceme-sdk/v1/viceme.min.js');
    expect(paths).toContain('/viceme-sdk/-/aliases/v1');
    expect(paths).toContain(`/viceme-sdk/${SDK_VERSION}/viceme.min.js`);
    expect(paths).toContain(`/viceme-sdk/${SDK_VERSION}/manifest.json`);
    expect(paths).toContain(`/viceme-sdk/${SDK_VERSION}/danmaku.js`);
    expect(paths).not.toContain('/viceme-sdk/v1/manifest.json');
    expect(new URL(page.url()).origin).not.toBe(S3_ALIAS_ORIGIN);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const portal = document.querySelector<HTMLElement>('[data-viceme-danmaku="mounted"]');
          const root = portal?.shadowRoot?.querySelector<HTMLElement>('div');
          const controls = portal?.shadowRoot?.querySelector<HTMLIFrameElement>(
            'iframe[data-mode="controls"]',
          );
          return {
            controlsBoxSizing: controls ? getComputedStyle(controls).boxSizing : null,
            portalPosition: portal ? getComputedStyle(portal).position : null,
            rootPosition: root ? getComputedStyle(root).position : null,
            shadowStyles: portal?.shadowRoot?.querySelectorAll('style').length ?? -1,
          };
        }),
      )
      .toEqual({
        controlsBoxSizing: 'border-box',
        portalPosition: 'fixed',
        rootPosition: 'fixed',
        shadowStyles: 0,
      });
    expect(styleCspErrors).toEqual([]);
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
    expect(runtimePaths).toContain('/viceme-sdk/v1/viceme.min.js');
    expect(runtimePaths).toContain('/viceme-sdk/v1/manifest.json');
    expect(runtimePaths).toContain('/viceme-sdk/v1/danmaku.js');
    expect(runtimePaths).not.toContain('/viceme-sdk/v1/index.js');
    for (const path of runtimePaths) {
      expect(path).toMatch(
        /^\/viceme-sdk\/v1\/(?:viceme\.min\.js|manifest\.json|danmaku\.js|tip\.js|chunks\/[a-zA-Z0-9._-]+\.js)$/,
      );
    }
    expect(requests.map((url) => new URL(url).pathname)).not.toContain('/viceme-sdk/-/aliases/v1');
    expectNoRemovedApiRequests(requests);
  });

  test('hosted iframe owns anonymous GET and POST without host credentials', async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'viceme-test-session',
        value: 'must-not-leak',
        url: DANMAKU_WIDGET_ORIGIN,
      },
    ]);
    const hosted = await mockHostedDanmaku(page);
    await page.goto('/pages/loader-static.html');
    await waitForEvent(page, 'viceme:ready');
    await expect.poll(() => hosted.apiRequests.length).toBe(2);

    expect(hosted.apiRequests.map((request) => request.method).sort()).toEqual(['GET', 'POST']);
    for (const request of hosted.apiRequests) {
      expect(request.frameIsMain).toBe(false);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.credentials).toBeUndefined();
      expect(new URL(request.url).pathname).toBe('/v1/danmaku/messages');
    }
    const post = hosted.apiRequests.find((request) => request.method === 'POST')!;
    expect(JSON.parse(post.postData ?? '{}')).toEqual({
      workKey: 'wrk_test',
      content: 'hello',
    });
  });
});

test.describe('hosted engagement loader', () => {
  test('mounts danmaku and Tip independently from one normalized declaration', async ({ page }) => {
    const requests = recordRequests(page);
    const danmaku = await mockHostedDanmaku(page);
    const tip = await mockHostedTip(page);
    await page.goto(cfgUrl({ ...VALID_ATTRS, 'data-viceme-features': 'tip,danmaku' }));

    const events = await waitForEvent(page, 'viceme:capability-ready', 2);
    expect(events.find((event) => event.type === 'viceme:ready')?.detail).toMatchObject({
      capabilities: ['danmaku', 'tip'],
      workKey: 'wrk_test',
    });
    expect(
      events
        .filter((event) => event.type === 'viceme:capability-ready')
        .map((event) => event.detail.capability)
        .sort(),
    ).toEqual(['danmaku', 'tip']);
    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(1);
    expect(await page.locator('[data-viceme-tip="mounted"]').count()).toBe(1);
    await expect.poll(() => danmaku.hits).toBe(2);
    await expect.poll(() => tip.hits).toBe(1);
    expect(tip.referers).toEqual([`${new URL(page.url()).origin}/`]);

    const runtimePaths = requests.map((url) => new URL(url).pathname);
    expect(runtimePaths).toContain('/viceme-sdk/v1/danmaku.js');
    expect(runtimePaths).toContain('/viceme-sdk/v1/tip.js');

    const tipFrame = page
      .frames()
      .find((frame) => new URL(frame.url(), page.url()).pathname.startsWith('/widget/tip/'));
    if (!tipFrame) throw new TypeError('Tip frame missing');
    await tipFrame.locator('#paid').click();
    await tipFrame.locator('#close').click();
    await waitForEvent(page, 'viceme:tip-paid');
    const paidEvents = await waitForEvent(page, 'viceme:widget-close');
    expect(paidEvents.find((event) => event.type === 'viceme:tip-paid')?.detail).toEqual({
      workId: '00000000-0000-4000-8000-000000000001',
      orderNo: 'VT20260827010203abcdef123456',
      status: 'PAID',
      amountCents: 520,
    });
    expect(paidEvents.find((event) => event.type === 'viceme:widget-close')?.detail).toEqual({
      workId: '00000000-0000-4000-8000-000000000001',
    });

    await page.evaluate(() => {
      const namespace = (
        window as unknown as {
          ViceMe: { versions: { v1: { destroyClient(key: string): void } } };
        }
      ).ViceMe.versions.v1;
      namespace.destroyClient('v1+cn+wrk_test');
    });
    await waitForEvent(page, 'viceme:destroyed', 2);
    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(0);
    expect(await page.locator('[data-viceme-tip="mounted"]').count()).toBe(0);
  });

  test('keeps danmaku mounted when the Tip chunk fails', async ({ page }) => {
    await mockHostedDanmaku(page);
    await page.route('**/viceme-sdk/*/tip.js', (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto(cfgUrl({ ...VALID_ATTRS, 'data-viceme-features': 'danmaku,tip' }));

    const events = await waitForEvent(page, 'viceme:ready');
    expect(events.find((event) => event.type === 'viceme:ready')?.detail).toMatchObject({
      capabilities: ['danmaku'],
    });
    expect(events.find((event) => event.type === 'viceme:error')?.detail).toMatchObject({
      code: 'INTERNAL_ERROR',
      capability: 'tip',
    });
    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(1);
    expect(await page.locator('[data-viceme-tip="mounted"]').count()).toBe(0);

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

  test('keeps Tip mounted when the danmaku chunk fails', async ({ page }) => {
    await mockHostedTip(page);
    await page.route('**/viceme-sdk/*/danmaku.js', (route) =>
      route.fulfill({ status: 404, body: '' }),
    );
    await page.goto(cfgUrl({ ...VALID_ATTRS, 'data-viceme-features': 'danmaku,tip' }));

    const events = await waitForEvent(page, 'viceme:ready');
    expect(events.find((event) => event.type === 'viceme:ready')?.detail).toMatchObject({
      capabilities: ['tip'],
    });
    expect(events.find((event) => event.type === 'viceme:error')?.detail).toMatchObject({
      code: 'INTERNAL_ERROR',
      capability: 'danmaku',
    });
    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(0);
    expect(await page.locator('[data-viceme-tip="mounted"]').count()).toBe(1);
  });

  test('starts Tip while the danmaku chunk is pending and cancels the loader on destroy', async ({
    page,
  }) => {
    await mockHostedTip(page);
    let releaseDanmaku!: () => void;
    const blockedDanmaku = new Promise<void>((resolve) => {
      releaseDanmaku = resolve;
    });
    await page.route('**/viceme-sdk/*/danmaku.js', async (route) => {
      await blockedDanmaku;
      await route.abort();
    });
    await page.goto(cfgUrl({ ...VALID_ATTRS, 'data-viceme-features': 'danmaku,tip' }), {
      waitUntil: 'domcontentloaded',
    });

    const events = await waitForEvent(page, 'viceme:capability-ready');
    expect(events.find((event) => event.type === 'viceme:capability-ready')?.detail).toMatchObject({
      capability: 'tip',
    });
    await expect(page.locator('[data-viceme-tip="mounted"]')).toHaveCount(1);

    await page.evaluate(() => {
      (
        window as unknown as {
          ViceMe: { versions: { v1: { destroyClient(key: string): void } } };
        }
      ).ViceMe.versions.v1.destroyClient('v1+cn+wrk_test');
    });
    await expect(page.locator('[data-viceme-tip="mounted"]')).toHaveCount(0, { timeout: 500 });
    releaseDanmaku();
  });
});

test.describe('release manifest trust boundary', () => {
  const manifestRoute = '**/viceme-sdk/v1/manifest.json';

  test('rejects release version and API major tears before loading a feature', async ({ page }) => {
    const cases = [
      { version: '9.9.9', apiMajor: API_MAJOR },
      { version: SDK_VERSION, apiMajor: API_MAJOR + 1 },
    ];

    for (const manifest of cases) {
      const handler = (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: releaseManifest(manifest),
        });
      await page.route(manifestRoute, handler);
      await page.goto(cfgUrl(VALID_ATTRS));

      const events = await waitForEvent(page, 'viceme:error');
      expect(events.find((event) => event.type === 'viceme:error')?.detail).toMatchObject({
        code: 'CONFIG_INVALID',
        retryable: false,
      });
      expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(0);
      await page.unroute(manifestRoute, handler);
    }
  });

  test('rejects unsafe danmaku feature paths without requesting them', async ({ page }) => {
    const requests = recordRequests(page);
    const unsafePaths = [
      'https://attacker.example/danmaku.js',
      '//attacker.example/danmaku.js',
      '/viceme-sdk/other/danmaku.js',
      'danmaku.js?cache=poisoned',
      'danmaku.js#poisoned',
      '../danmaku.js',
      'chunks/../danmaku.js',
      'other/danmaku.js',
    ];
    await page.route('https://attacker.example/**', (route) => route.abort());

    for (const featurePath of unsafePaths) {
      const handler = (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: releaseManifest({ features: { danmaku: featurePath, tip: 'tip.js' } }),
        });
      await page.route(manifestRoute, handler);
      const requestStart = requests.length;
      await page.goto(cfgUrl(VALID_ATTRS));

      const events = await waitForEvent(page, 'viceme:error');
      expect(
        events.find((event) => event.type === 'viceme:error')?.detail,
        featurePath,
      ).toMatchObject({ code: 'CONFIG_INVALID', retryable: false });
      expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(0);

      const resolved = new URL(
        featurePath,
        `${new URL(page.url()).origin}/viceme-sdk/v1/manifest.json`,
      );
      resolved.hash = '';
      expect(requests.slice(requestStart), featurePath).not.toContain(resolved.href);
      await page.unroute(manifestRoute, handler);
    }
  });

  test('rejects every additional manifest feature key', async ({ page }) => {
    await page.route(manifestRoute, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: releaseManifest({
          features: { danmaku: 'danmaku.js', tip: 'tip.js', checkout: 'checkout.js' },
        }),
      }),
    );
    await page.goto(cfgUrl(VALID_ATTRS));

    const events = await waitForEvent(page, 'viceme:error');
    expect(events.find((event) => event.type === 'viceme:error')?.detail).toMatchObject({
      code: 'CONFIG_INVALID',
      retryable: false,
    });
    expect(await page.locator('[data-viceme-danmaku="mounted"]').count()).toBe(0);
  });
});

test.describe('hosted frame readiness failures', () => {
  for (const failure of ['network-error', 'http-500', 'no-ready'] as const) {
    test(`${failure} removes the partial portal and emits one stable degradation error`, async ({
      page,
    }) => {
      await mockHostedDanmaku(page, { behavior: failure });
      await page.goto('/pages/loader-static.html');

      await expect
        .poll(async () => {
          const portal = page.locator('[data-viceme-danmaku="mounted"]');
          if ((await portal.count()) === 0) return null;
          return portal.evaluate((element) =>
            element.shadowRoot
              ?.querySelector<HTMLIFrameElement>('iframe[data-mode="controls"]')
              ?.style.getPropertyValue('pointer-events'),
          );
        })
        .toBe('none');

      await page.locator('#host-through-action').click();
      await expect(page.locator('#host-through-status')).toHaveText('clicked');

      const events = await waitForEvent(page, 'viceme:error');
      const errors = events.filter((event) => event.type === 'viceme:error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.detail).toMatchObject({
        capability: 'danmaku',
        clientKey: 'v1+cn+wrk_test',
        code: 'INTERNAL_ERROR',
        retryable: true,
      });
      await expect(page.locator('[data-viceme-danmaku="mounted"]')).toHaveCount(0);

      await page.locator('#host-action').click();
      await expect(page.locator('#host-status')).toHaveText('clicked');
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
  }
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

  test('destroy during frame readiness immediately removes a partial mount', async ({ page }) => {
    await mockHostedDanmaku(page, { behavior: 'no-ready' });
    await page.goto(cfgUrl(VALID_ATTRS));
    await expect(page.locator('[data-viceme-danmaku="mounted"]')).toHaveCount(1);

    await page.evaluate(() => {
      const namespace = (
        window as unknown as {
          ViceMe: { versions: { v1: { destroyClient(key: string): void } } };
        }
      ).ViceMe.versions.v1;
      namespace.destroyClient('v1+cn+wrk_test');
    });

    await expect(page.locator('[data-viceme-danmaku="mounted"]')).toHaveCount(0, {
      timeout: 500,
    });
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __events: RecordedEvent[] }).__events.filter(
            (event) => event.type === 'viceme:ready' || event.type === 'viceme:capability-ready',
          ).length,
      ),
    ).toBe(0);
  });

  test('destroy during Tip readiness immediately removes a partial mount', async ({ page }) => {
    await mockHostedTip(page, { ready: false });
    await page.goto(cfgUrl({ ...VALID_ATTRS, 'data-viceme-features': 'tip' }));
    await expect(page.locator('[data-viceme-tip="mounted"]')).toHaveCount(1);

    await page.evaluate(() => {
      (
        window as unknown as {
          ViceMe: { versions: { v1: { destroyClient(key: string): void } } };
        }
      ).ViceMe.versions.v1.destroyClient('v1+cn+wrk_test');
    });

    await expect(page.locator('[data-viceme-tip="mounted"]')).toHaveCount(0, { timeout: 500 });
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __events: RecordedEvent[] }).__events.filter(
            (event) => event.type === 'viceme:ready' || event.type === 'viceme:capability-ready',
          ).length,
      ),
    ).toBe(0);
  });
});

test.describe('host interaction, anchors, and hosted accessibility boundary', () => {
  test('keeps controls inert until both hosted frames explicitly report ready', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await mockHostedDanmaku(page, { behavior: 'no-ready' });
    await page.goto('/pages/loader-static.html');

    const portal = page.locator('[data-viceme-danmaku="mounted"]');
    await expect(portal).toHaveCount(1);
    await expect
      .poll(() =>
        portal.evaluate((element) =>
          element.shadowRoot
            ?.querySelector<HTMLIFrameElement>('iframe[data-mode="controls"]')
            ?.style.getPropertyValue('pointer-events'),
        ),
      )
      .toBe('none');
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __events: RecordedEvent[] }).__events.filter(
            (event) => event.type === 'viceme:ready',
          ).length,
      ),
    ).toBe(0);

    await page.locator('#host-through-action').click();
    await expect(page.locator('#host-through-status')).toHaveText('clicked');
    const stage = await waitForFrameMode(page, 'stage');
    const controls = await waitForFrameMode(page, 'controls');
    await stage.evaluate(() =>
      parent.postMessage({ source: 'viceme-danmaku', action: 'frame-ready', mode: 'stage' }, '*'),
    );
    await controls.evaluate(() => {
      parent.postMessage(
        {
          source: 'viceme-danmaku',
          action: 'resize-controls',
          width: 480,
          height: 56,
        },
        '*',
      );
      parent.postMessage(
        { source: 'viceme-danmaku', action: 'frame-ready', mode: 'controls' },
        '*',
      );
    });
    await waitForEvent(page, 'viceme:ready');
    await expect
      .poll(() =>
        portal.evaluate((element) =>
          element.shadowRoot
            ?.querySelector<HTMLIFrameElement>('iframe[data-mode="controls"]')
            ?.style.getPropertyValue('pointer-events'),
        ),
      )
      .toBe('auto');
  });

  test('uses tight collapsed, expanded, and more hit regions without blocking the old rectangle', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await mockHostedDanmaku(page);
    await page.goto('/pages/loader-static.html');
    await waitForEvent(page, 'viceme:ready');

    const controls = await waitForFrameMode(page, 'controls');
    const controlsElement = page.locator(
      '[data-viceme-danmaku="mounted"] iframe[data-mode="controls"]',
    );
    await expectFrameSize(controlsElement, 480, 56);

    await controls.locator('#interact').click();
    await expect(controls.locator('body')).toHaveAttribute('data-interacted', 'true');

    const controlsBox = await controlsElement.boundingBox();
    const hostButton = page.locator('#host-through-action');
    const hostButtonBox = await hostButton.boundingBox();
    expect(hostButtonBox!.x).toBeGreaterThanOrEqual(controlsBox!.x);
    expect(hostButtonBox!.x + hostButtonBox!.width).toBeLessThanOrEqual(
      controlsBox!.x + controlsBox!.width,
    );
    expect(hostButtonBox!.y).toBeGreaterThanOrEqual(720 - 136);
    expect(hostButtonBox!.y + hostButtonBox!.height).toBeLessThanOrEqual(controlsBox!.y);

    await hostButton.click();
    await expect(page.locator('#host-through-status')).toHaveText('clicked');

    await controls.locator('#collapse').click();
    await expectFrameSize(controlsElement, 32, 32);
    await controls.locator('#expand').press('Enter');
    await expectFrameSize(controlsElement, 480, 56);
    await controls.locator('#more').click();
    await expectFrameSize(controlsElement, 352, 328);
    await controls.locator('#more').click();
    await expectFrameSize(controlsElement, 480, 56);

    await page.setViewportSize({ width: 375, height: 720 });
    await expectFrameSize(controlsElement, 375, 56);
  });

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

  test('keeps an unready modal click-through and hides it after the bounded timeout', async ({
    page,
  }) => {
    const hosted = await mockHostedDanmaku(page, { skipReadyModes: ['modal'] });
    await page.goto('/pages/loader-static.html');
    await waitForEvent(page, 'viceme:ready');
    const controls = await waitForFrameMode(page, 'controls');
    await controls.locator('#open').click();
    await expect.poll(() => hosted.hits).toBe(3);

    const modalElement = page.locator('[data-viceme-danmaku="mounted"] iframe[data-mode="modal"]');
    await expect(modalElement).toHaveCSS('display', 'block');
    await expect(modalElement).toHaveCSS('pointer-events', 'none');
    await page.locator('#host-action').click();
    await expect(page.locator('#host-status')).toHaveText('clicked');

    await expect(modalElement).toHaveCSS('display', 'none', { timeout: 12_000 });
    await expect(modalElement).toHaveAttribute('src', 'about:blank');
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
