import { expect, test, type Page, type Route } from '@playwright/test';

import { SDK_VERSION } from '../../src/version.ts';

const DANMAKU_WIDGET_ORIGIN = (
  process.env.VICEME_BUILD_CN_WIDGET_ORIGIN ?? 'https://viceme.cn'
).replace(/\/+$/, '');

/**
 * B0.1 loader browser matrix (§21.1): attribute validation, dedup, namespace
 * coexistence, capability failure isolation, destroy, storage/global hygiene,
 * and Shadow DOM isolation — against the real built loader/core/fixture
 * chunks served through the local CDN-layout server. The public API is
 * mocked at the network layer with Playwright routing (CORS included).
 */

interface RecordedEvent {
  type: string;
  detail: Record<string, unknown>;
}

interface MockApiOptions {
  status?: number;
  body?: unknown;
  delayMs?: number;
  capabilities?: string[];
}

async function mockApi(page: Page, options: MockApiOptions = {}) {
  let hits = 0;
  await page.route('**/public/v1/work-sessions', async (route: Route) => {
    hits += 1;
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-client-request-id',
      'access-control-max-age': '600',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (options.delayMs) {
      // Plain timer (not page.waitForTimeout): route callbacks must survive
      // past test teardown when intentionally stalling.
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const status = options.status ?? 201;
    const body =
      options.body ??
      (status < 300
        ? {
            work: { key: 'wrk_test', capabilities: options.capabilities ?? ['fixture'] },
            token: 'test-token',
          }
        : { error: { code: 'WORK_NOT_FOUND', message: 'no such work' } });
    await route.fulfill({
      status,
      headers: { ...cors, 'content-type': 'application/json', 'x-request-id': 'srv-1' },
      body: JSON.stringify(body),
    });
  });
  return {
    get hits() {
      return hits;
    },
  };
}

async function mockHostedDanmaku(page: Page) {
  let hits = 0;
  await page.route(`${DANMAKU_WIDGET_ORIGIN}/embed/danmaku**`, async (route: Route) => {
    hits += 1;
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <html><body data-mode="${url.searchParams.get('mode') ?? ''}">
          <script>
            window.addEventListener('message', (event) => {
              if (event.data?.source !== 'viceme-danmaku') return;
              if (event.data.action === 'anchor-change') {
                document.body.dataset.anchor = event.data.anchorKey;
              }
            });
            window.parent.postMessage(
              { source: 'viceme-danmaku', action: 'request-anchor' },
              '*',
            );
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

function cfgUrl(attrs: Record<string, string>, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  params.set('cfg', encodeURIComponent(JSON.stringify({ attrs })));
  return `/pages/loader-dynamic.html?${params.toString()}`;
}

const VALID_ATTRS: Record<string, string> = {
  'data-viceme-work': 'wrk_test',
  'data-viceme-region': 'cn',
  'data-viceme-features': 'fixture',
  'data-viceme-target': '#host-a',
};

async function waitForEvent(
  page: Page,
  type: string,
  count = 1,
  timeout?: number,
): Promise<RecordedEvent[]> {
  return page
    .waitForFunction(
      ({ type, count }) => {
        const events = (window as { __events?: { type: string }[] }).__events ?? [];
        return events.filter((e) => e.type === type).length >= count;
      },
      { type, count },
      timeout !== undefined ? { timeout } : undefined,
    )
    .then(() => page.evaluate(() => (window as unknown as { __events: RecordedEvent[] }).__events));
}

/* ------------------------------------------------------------------ */

test.describe('successful auto-mount', () => {
  test('static deferred script mounts fixture into Shadow DOM and emits events', async ({
    page,
  }) => {
    const api = await mockApi(page);
    await page.goto('/pages/loader-static.html');

    const events = await waitForEvent(page, 'viceme:ready');
    const ready = events.find((e) => e.type === 'viceme:ready')!;
    expect(ready.detail).toMatchObject({
      clientKey: 'v1+cn+wrk_test',
      workKey: 'wrk_test',
      capabilities: ['fixture'],
    });

    const capabilityReady = events.find((e) => e.type === 'viceme:capability-ready');
    expect(capabilityReady?.detail.capability).toBe('fixture');
    // Detail allowlist only.
    for (const key of Object.keys(capabilityReady!.detail)) {
      expect(['clientKey', 'instanceKey', 'capability', 'version']).toContain(key);
    }

    // Shadow DOM mounted, host page untouched.
    const mounted = await page.evaluate(() => {
      const host = document.querySelector('#viceme-host')!;
      const root = host.shadowRoot!;
      const box = root.querySelector('.viceme-fixture') as HTMLElement;
      return {
        hasShadow: !!host.shadowRoot,
        text: box?.textContent ?? '',
        theme: box?.dataset.theme ?? '',
        visible: box instanceof HTMLElement && box.getBoundingClientRect().height > 0,
        hostChildren: host.childNodes.length,
        status: document.querySelector('#status')?.textContent,
      };
    });
    expect(mounted.hasShadow).toBe(true);
    expect(mounted.text).toContain('ViceMe fixture');
    expect(mounted.text).toContain('wrk_test');
    expect(mounted.theme).toBe('dark');
    expect(mounted.visible).toBe(true);
    expect(mounted.status).toBe('untouched');

    // Namespace installed with diagnostics + destroy surface only.
    const namespace = await page.evaluate(() => {
      const ns = (window as { ViceMe?: { versions: Record<string, unknown> } }).ViceMe?.versions
        .v1 as Record<string, unknown>;
      return {
        exists: !!ns,
        keys: ns ? Object.keys(ns).sort() : [],
        enumerableGlobals: Object.getOwnPropertyNames(window).filter((k) =>
          k.toLowerCase().includes('viceme'),
        ),
      };
    });
    expect(namespace.exists).toBe(true);
    expect(namespace.keys).toEqual([
      'destroyClient',
      'destroyInstance',
      'getInstance',
      'version',
      'whenReady',
    ]);
    expect(namespace.enumerableGlobals).toEqual(['ViceMe']);

    // Exactly one public API session per client.
    expect(api.hits).toBe(1);
  });

  test('dynamic insertion after DOM ready works', async ({ page }) => {
    await mockApi(page);
    await page.goto(cfgUrl(VALID_ATTRS));
    await waitForEvent(page, 'viceme:ready');
    expect(await page.evaluate(() => !!document.querySelector('#host-a')!.shadowRoot)).toBe(true);
  });

  test('four-line danmaku loader preserves host clicks and tracks page position', async ({
    page,
  }) => {
    await mockApi(page, { capabilities: ['danmaku'] });
    const hosted = await mockHostedDanmaku(page);
    await page.goto('/pages/danmaku-static.html#/chapter/1');
    const events = await waitForEvent(page, 'viceme:ready');
    expect(events.find((event) => event.type === 'viceme:ready')?.detail.capabilities).toEqual([
      'danmaku',
    ]);

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
    expect(hosted.hits).toBe(2); // stage + controls; modal stays lazy

    await page.locator('#host-action').click();
    await expect(page.locator('#host-status')).toHaveText('clicked');

    const stage = page
      .frames()
      .find((frame) => new URL(frame.url()).searchParams.get('mode') === 'stage');
    expect(stage).toBeDefined();
    await expect(stage!.locator('body')).toHaveAttribute('data-anchor', /:scroll:0-10$/);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(stage!.locator('body')).toHaveAttribute('data-anchor', /:scroll:90-100$/);

    const beforeNavigation = await stage!.locator('body').getAttribute('data-anchor');
    await page.evaluate(() => window.history.pushState(null, '', '/next#/chapter/2'));
    await expect
      .poll(() => stage!.locator('body').getAttribute('data-anchor'))
      .not.toBe(beforeNavigation);
  });

  test('v1 alias without a manifest resolves through the version pointer', async ({ page }) => {
    await mockApi(page);
    // Alias topology: /viceme-sdk/v1/ serves ONLY the loader; manifest.json under
    // the alias must 404 so the loader falls back to /viceme-sdk/-/aliases/v1 and
    // loads the exact version beside it.
    await page.route('**/viceme-sdk/v1/manifest.json', (route) => route.fulfill({ status: 404 }));
    await page.goto(cfgUrl(VALID_ATTRS));

    const events = await waitForEvent(page, 'viceme:ready');
    const ready = events.find((e) => e.type === 'viceme:ready')!;
    // Release preparation updates the package/runtime version before running
    // this suite. Assert against that generated source of truth instead of a
    // version literal from the previous release.
    expect(ready.detail.version).toBe(SDK_VERSION);
    expect(await page.evaluate(() => !!document.querySelector('#host-a')!.shadowRoot)).toBe(true);
  });
});

test.describe('attribute validation (fail closed)', () => {
  const cases: Array<{ name: string; attrs: Record<string, string> }> = [
    { name: 'missing work', attrs: { ...VALID_ATTRS, 'data-viceme-work': '' } },
    { name: 'invalid region', attrs: { ...VALID_ATTRS, 'data-viceme-region': 'eu' } },
    { name: 'missing features', attrs: { ...VALID_ATTRS, 'data-viceme-features': '' } },
    {
      name: 'invalid feature name',
      attrs: { ...VALID_ATTRS, 'data-viceme-features': 'Not A Name' },
    },
    { name: 'unknown attribute rejected', attrs: { ...VALID_ATTRS, 'data-viceme-token': 'nope' } },
    {
      name: 'missing target',
      attrs: {
        'data-viceme-work': 'wrk_test',
        'data-viceme-region': 'cn',
        'data-viceme-features': 'fixture',
      },
    },
    { name: 'target matches nothing', attrs: { ...VALID_ATTRS, 'data-viceme-target': '#nope' } },
    { name: 'target matches multiple', attrs: { ...VALID_ATTRS, 'data-viceme-target': '.multi' } },
  ];

  for (const { name, attrs } of cases) {
    test(name, async ({ page }) => {
      await mockApi(page);
      await page.goto(cfgUrl(attrs));
      const events = await waitForEvent(page, 'viceme:error');
      const error = events.find((e) => e.type === 'viceme:error')!;
      expect(error.detail.code).toBe('CONFIG_INVALID');
      expect(error.detail.retryable).toBe(false);
      // Allowlisted keys only — no messages, tokens, or internals.
      for (const key of Object.keys(error.detail)) {
        expect([
          'clientKey',
          'instanceKey',
          'capability',
          'code',
          'retryable',
          'requestId',
        ]).toContain(key);
      }

      // No phantom nodes, no namespace, no shadow roots.
      const state = await page.evaluate(() => ({
        viceMe: typeof (window as { ViceMe?: unknown }).ViceMe,
        shadowRoots: [...document.querySelectorAll('body *')].filter((el) => el.shadowRoot).length,
      }));
      expect(state.viceMe).toBe('undefined');
      expect(state.shadowRoots).toBe(0);
    });
  }
});

test.describe('deduplication and namespaces', () => {
  test('two identical scripts share one client and one mount', async ({ page }) => {
    const api = await mockApi(page);
    const params = new URLSearchParams();
    params.set('cfg', encodeURIComponent(JSON.stringify({ scripts: [VALID_ATTRS, VALID_ATTRS] })));
    await page.goto(`/pages/loader-dynamic.html?${params.toString()}`);

    await waitForEvent(page, 'viceme:ready');
    await page.waitForTimeout(300); // let the second run settle

    const state = await page.evaluate(() => {
      const events = (window as unknown as { __events: RecordedEvent[] }).__events;
      return {
        readyCount: events.filter((e) => e.type === 'viceme:ready').length,
        capabilityReadyCount: events.filter((e) => e.type === 'viceme:capability-ready').length,
        shadowChildren: document.querySelector('#host-a')!.shadowRoot!.childNodes.length,
      };
    });
    expect(state.readyCount).toBe(1);
    expect(state.capabilityReadyCount).toBe(1);
    expect(state.shadowChildren).toBe(2); // style + fixture div
    expect(api.hits).toBe(1);
  });

  test('same work with different targets shares the client, mounts twice', async ({ page }) => {
    const api = await mockApi(page);
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
    const state = await page.evaluate(() => ({
      a: !!document.querySelector('#host-a')!.shadowRoot,
      b: !!document.querySelector('#host-b')!.shadowRoot,
    }));
    expect(state.a).toBe(true);
    expect(state.b).toBe(true);
    expect(api.hits).toBe(1);
  });

  test('v1 and v2 namespaces coexist', async ({ page }) => {
    await mockApi(page);
    await page.goto(cfgUrl(VALID_ATTRS, { presetV2: '1' }));
    await waitForEvent(page, 'viceme:ready');

    const state = await page.evaluate(() => {
      const versions = (window as { ViceMe?: { versions: Record<string, unknown> } }).ViceMe!
        .versions;
      // v1 is installed non-enumerably, so use own-property names.
      return { majors: Object.getOwnPropertyNames(versions).sort(), v2: versions.v2 };
    });
    expect(state.majors).toEqual(['v1', 'v2']);
    expect((state.v2 as { marker?: string }).marker).toBe('keep-me');
  });
});

test.describe('failure isolation', () => {
  test('capability chunk failure degrades the client but keeps the host page', async ({ page }) => {
    await mockApi(page);
    // Serve the fixture chunk as 404 from the local server.
    await page.route('**/viceme-sdk/*/fixture.js', (route) =>
      route.fulfill({ status: 404, body: '' }),
    );
    await page.goto(cfgUrl(VALID_ATTRS));

    const events = await waitForEvent(page, 'viceme:error');
    const error = events.find(
      (e) => e.type === 'viceme:error' && e.detail.capability === 'fixture',
    )!;
    expect(error.detail.code).toBe('INTERNAL_ERROR');

    const state = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent,
      shadowRoots: [...document.querySelectorAll('body *')].filter((el) => el.shadowRoot).length,
    }));
    expect(state.status).toBe('untouched');
    expect(state.shadowRoots).toBe(0);
    // Client is degraded but alive.
    const clientState = await page.evaluate(async () => {
      const ns = (
        window as unknown as {
          ViceMe?: { versions: { v1?: { whenReady(k: string): Promise<{ state: string }> } } };
        }
      ).ViceMe?.versions.v1;
      const client = await ns!.whenReady('v1+cn+wrk_test');
      return client.state;
    });
    expect(clientState).toBe('DEGRADED');
  });

  test('undeclared feature reports CAPABILITY_DISABLED; remaining feature still mounts', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(cfgUrl({ ...VALID_ATTRS, 'data-viceme-features': 'fixture,ghost' }));

    const events = await waitForEvent(page, 'viceme:ready');
    const disabled = events.find(
      (e) => e.type === 'viceme:error' && e.detail.capability === 'ghost',
    )!;
    expect(disabled.detail.code).toBe('CAPABILITY_DISABLED');
    const ready = events.find((e) => e.type === 'viceme:ready')!;
    expect(ready.detail.capabilities).toEqual(['fixture']);
  });

  test('session failure surfaces as viceme:error with stable code', async ({ page }) => {
    await mockApi(page, { status: 404 });
    await page.goto(cfgUrl(VALID_ATTRS));

    const events = await waitForEvent(page, 'viceme:error');
    const error = events.find((e) => e.type === 'viceme:error')!;
    expect(error.detail.code).toBe('WORK_NOT_FOUND');
    expect(error.detail.retryable).toBe(false);
  });

  test('initialization timeout degrades without breaking the host page', async ({ page }) => {
    test.setTimeout(45_000);
    // Transport default timeout is 10s; the API never answers in time.
    await mockApi(page, { delayMs: 20_000 });
    await page.goto(cfgUrl(VALID_ATTRS));

    const events = await waitForEvent(page, 'viceme:error', 1, 20_000);
    const error = events.find(
      (e) => e.type === 'viceme:error' && e.detail.code === 'NETWORK_TIMEOUT',
    )!;
    expect(error.detail.retryable).toBe(true);

    const status = await page.evaluate(() => document.querySelector('#status')?.textContent);
    expect(status).toBe('untouched');
  });
});

test.describe('destroy lifecycle', () => {
  test('destroyInstance removes the mount and emits viceme:destroyed', async ({ page }) => {
    await mockApi(page);
    await page.goto(cfgUrl(VALID_ATTRS));
    const events = await waitForEvent(page, 'viceme:capability-ready');
    const instanceKey = events.find((e) => e.type === 'viceme:capability-ready')!.detail
      .instanceKey as string;

    await page.evaluate((key) => {
      (
        window as { ViceMe?: { versions: { v1?: { destroyInstance(k: string): void } } } }
      ).ViceMe!.versions.v1!.destroyInstance(key);
    }, instanceKey);

    await waitForEvent(page, 'viceme:destroyed');
    const state = await page.evaluate(() => ({
      shadowChildren: document.querySelector('#host-a')!.shadowRoot?.childNodes.length ?? -1,
    }));
    expect(state.shadowChildren).toBe(0);
  });

  test('destroyClient fails closed afterwards; a fresh script can re-mount', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(cfgUrl(VALID_ATTRS));
    await waitForEvent(page, 'viceme:ready');

    const destroyed = await page.evaluate(async () => {
      const ns = (
        window as {
          ViceMe?: {
            versions: {
              v1?: { destroyClient(k: string): void; whenReady(k: string): Promise<unknown> };
            };
          };
        }
      ).ViceMe!.versions.v1!;
      ns.destroyClient('v1+cn+wrk_test');
      try {
        await ns.whenReady('v1+cn+wrk_test');
        return 'resolved';
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
    });
    expect(destroyed).toBe('CONFIG_INVALID'); // unregistered after destroy

    // Re-inserting the loader script creates a fresh client + session.
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = '/viceme-sdk/v1/viceme.min.js';
      s.setAttribute('data-viceme-work', 'wrk_test');
      s.setAttribute('data-viceme-region', 'cn');
      s.setAttribute('data-viceme-features', 'fixture');
      s.setAttribute('data-viceme-target', '#host-a');
      document.body.append(s);
    });
    await waitForEvent(page, 'viceme:ready', 2);
    expect(api.hits).toBe(2);
  });
});

test.describe('host page hygiene', () => {
  test('no storage, cookie, or global CSS writes', async ({ page }) => {
    await mockApi(page);
    await page.goto(cfgUrl(VALID_ATTRS));
    await waitForEvent(page, 'viceme:ready');

    const state = await page.evaluate(() => ({
      localStorage: window.localStorage.length,
      cookie: document.cookie,
      styleSheets: document.styleSheets.length,
    }));
    expect(state.localStorage).toBe(0);
    expect(state.cookie).toBe('');
    expect(state.styleSheets).toBe(1); // the page's own stylesheet only
  });

  test('hostile global reset does not break the component; component CSS stays inside Shadow DOM', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto(cfgUrl(VALID_ATTRS, { hostileCss: '1' }));
    await waitForEvent(page, 'viceme:ready');

    const state = await page.evaluate(() => {
      const box = document
        .querySelector('#host-a')!
        .shadowRoot!.querySelector('.viceme-fixture') as HTMLElement;
      const outside = document.querySelector('#status') as HTMLElement;
      const boxStyle = getComputedStyle(box);
      return {
        componentVisible: box.getBoundingClientRect().height > 0,
        // Page `* { padding: 0 !important }` cannot pierce the Shadow Root.
        componentPadding: boxStyle.padding,
        // The fixture's scoped padding must not leak to the host page.
        outsidePadding: getComputedStyle(outside).padding,
      };
    });
    expect(state.componentVisible).toBe(true);
    expect(state.componentPadding).toBe('8px 12px');
    expect(state.outsidePadding).toBe('0px');
  });
});
