import type { ViceMeClient } from '../core/client.ts';
import { ViceMeError } from '../core/errors.ts';
import type { CapabilityMountHandle, CapabilityMountOptions } from '../loader/mount-handle.ts';
import { SDK_VERSION } from '../version.ts';
import { readDanmakuPageAnchor, type DanmakuPageAnchor } from './anchor.ts';

type DanmakuFrameMode = 'stage' | 'controls' | 'modal';

interface DanmakuBridgeMessage {
  source?: unknown;
  action?: unknown;
  height?: unknown;
}

const WIDGET_ORIGINS = {
  cn: 'https://viceme.cn',
  global: 'https://viceme.ai',
} as const;

const CONTROLS_MIN_HEIGHT = 136;
const CONTROLS_MAX_HEIGHT = 360;
const ANCHOR_DEBOUNCE_MS = 120;
const LOCATION_POLL_MS = 1_000;

export async function mount(
  client: ViceMeClient,
  options: CapabilityMountOptions,
): Promise<CapabilityMountHandle> {
  await client.ready();
  if (!client.hasCapability('danmaku')) {
    throw new ViceMeError({
      code: 'CAPABILITY_DISABLED',
      message: 'Danmaku is not enabled for this work.',
      retryable: false,
      capability: 'danmaku',
    });
  }

  const documentObject = options.target.ownerDocument;
  const windowObject = documentObject.defaultView;
  if (!windowObject) {
    throw new ViceMeError({
      code: 'CONFIG_INVALID',
      message: 'Danmaku requires a browser document.',
      retryable: false,
      capability: 'danmaku',
    });
  }

  const widgetOrigin = WIDGET_ORIGINS[client.region];
  let currentAnchor = readDanmakuPageAnchor(windowObject, documentObject);
  let destroyed = false;
  let anchorTimer: number | undefined;
  const loadedFrames = new WeakSet<HTMLIFrameElement>();

  const portal = documentObject.createElement('div');
  portal.dataset.vicemeDanmaku = 'mounted';
  portal.style.position = 'fixed';
  portal.style.inset = '0';
  portal.style.width = '100%';
  portal.style.height = '100%';
  portal.style.pointerEvents = 'none';
  portal.style.zIndex = '2147483000';
  portal.style.contain = 'layout style size';

  const shadow = portal.attachShadow({ mode: 'open' });
  const style = documentObject.createElement('style');
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    iframe { color-scheme: normal; }
  `;
  const root = documentObject.createElement('div');
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.pointerEvents = 'none';
  shadow.append(style, root);

  const frameUrl = (mode: DanmakuFrameMode): URL => {
    const url = new URL('/embed/danmaku', widgetOrigin);
    url.searchParams.set('mode', mode);
    url.searchParams.set('workKey', client.workKey);
    url.searchParams.set('theme', options.theme);
    url.searchParams.set('locale', windowObject.navigator.language || 'en');
    url.searchParams.set('sdk', SDK_VERSION);
    url.searchParams.set('anchorKey', currentAnchor.anchorKey);
    return url;
  };

  const createFrame = (
    mode: DanmakuFrameMode,
    title: string,
    source: string,
  ): HTMLIFrameElement => {
    const frame = documentObject.createElement('iframe');
    frame.title = title;
    frame.src = source;
    frame.loading = 'eager';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute(
      'sandbox',
      'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
    );
    frame.dataset.mode = mode;
    frame.style.position = 'fixed';
    frame.style.margin = '0';
    frame.style.border = '0';
    frame.style.background = 'transparent';
    frame.style.width = '100%';
    frame.style.zIndex = '2147483000';
    return frame;
  };

  const stage = createFrame('stage', 'ViceMe Danmaku', frameUrl('stage').toString());
  stage.setAttribute('aria-hidden', 'true');
  stage.style.inset = '0';
  stage.style.height = '100%';
  stage.style.pointerEvents = 'none';

  const controls = createFrame(
    'controls',
    'ViceMe Danmaku controls',
    frameUrl('controls').toString(),
  );
  controls.style.left = '0';
  controls.style.right = '0';
  controls.style.bottom = '0';
  controls.style.height = `calc(${CONTROLS_MIN_HEIGHT}px + env(safe-area-inset-bottom, 0px))`;
  controls.style.pointerEvents = 'auto';

  const modal = createFrame('modal', 'ViceMe Danmaku dialog', 'about:blank');
  modal.dataset.src = frameUrl('modal').toString();
  modal.style.inset = '0';
  modal.style.height = '100%';
  modal.style.display = 'none';
  modal.style.pointerEvents = 'auto';

  root.append(stage, controls, modal);
  options.target.appendChild(portal);

  const postAnchor = (frame: HTMLIFrameElement): void => {
    if (!loadedFrames.has(frame)) return;
    frame.contentWindow?.postMessage(
      {
        source: 'viceme-danmaku',
        action: 'anchor-change',
        anchorKey: currentAnchor.anchorKey,
      },
      widgetOrigin,
    );
  };
  const postAnchorToMountedFrames = (): void => {
    postAnchor(stage);
    postAnchor(controls);
    if (modal.getAttribute('src') !== 'about:blank') postAnchor(modal);
  };

  const refreshAnchor = (): DanmakuPageAnchor => {
    if (destroyed) return currentAnchor;
    const next = readDanmakuPageAnchor(windowObject, documentObject);
    if (next.anchorKey !== currentAnchor.anchorKey) {
      currentAnchor = next;
      postAnchorToMountedFrames();
    }
    return currentAnchor;
  };
  const scheduleAnchorRefresh = (): void => {
    if (anchorTimer !== undefined) windowObject.clearTimeout(anchorTimer);
    anchorTimer = windowObject.setTimeout(refreshAnchor, ANCHOR_DEBOUNCE_MS);
  };

  const frameLoaded = (event: Event): void => {
    const frame = event.currentTarget as HTMLIFrameElement;
    if (frame.getAttribute('src') === 'about:blank') return;
    loadedFrames.add(frame);
    postAnchor(frame);
  };
  stage.addEventListener('load', frameLoaded);
  controls.addEventListener('load', frameLoaded);
  modal.addEventListener('load', frameLoaded);

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== widgetOrigin) return;
    const fromStage = event.source === stage.contentWindow;
    const fromControls = event.source === controls.contentWindow;
    const fromModal = event.source === modal.contentWindow;
    if (!fromStage && !fromControls && !fromModal) return;

    const message = event.data as DanmakuBridgeMessage | null;
    if (!message || message.source !== 'viceme-danmaku') return;

    if (message.action === 'resize-controls' && fromControls) {
      const requested = Number(message.height);
      const height = Math.max(
        CONTROLS_MIN_HEIGHT,
        Math.min(CONTROLS_MAX_HEIGHT, Number.isFinite(requested) ? requested : CONTROLS_MIN_HEIGHT),
      );
      controls.style.height = `calc(${height}px + env(safe-area-inset-bottom, 0px))`;
    }
    if (message.action === 'request-anchor') {
      postAnchor(fromModal ? modal : fromStage ? stage : controls);
    }
    if (message.action === 'open-modal' && fromControls) {
      if (modal.getAttribute('src') === 'about:blank') {
        modal.src = modal.dataset.src ?? 'about:blank';
      }
      modal.style.display = 'block';
    }
    if (message.action === 'close-modal' && (fromModal || fromControls)) {
      modal.style.display = 'none';
    }
  };

  windowObject.addEventListener('message', onMessage);
  windowObject.addEventListener('scroll', scheduleAnchorRefresh, { passive: true });
  windowObject.addEventListener('resize', scheduleAnchorRefresh);
  windowObject.addEventListener('popstate', scheduleAnchorRefresh);
  windowObject.addEventListener('hashchange', scheduleAnchorRefresh);
  const locationPoll = windowObject.setInterval(refreshAnchor, LOCATION_POLL_MS);
  postAnchorToMountedFrames();

  return {
    capability: 'danmaku',
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (anchorTimer !== undefined) windowObject.clearTimeout(anchorTimer);
      windowObject.clearInterval(locationPoll);
      windowObject.removeEventListener('message', onMessage);
      windowObject.removeEventListener('scroll', scheduleAnchorRefresh);
      windowObject.removeEventListener('resize', scheduleAnchorRefresh);
      windowObject.removeEventListener('popstate', scheduleAnchorRefresh);
      windowObject.removeEventListener('hashchange', scheduleAnchorRefresh);
      stage.removeEventListener('load', frameLoaded);
      controls.removeEventListener('load', frameLoaded);
      modal.removeEventListener('load', frameLoaded);
      portal.remove();
    },
  };
}
