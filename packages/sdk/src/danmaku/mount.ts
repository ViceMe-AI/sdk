import type { ViceMeClient } from '../core/client.ts';
import { BUILD_WIDGET_ORIGINS } from '../core/build-endpoints.ts';
import { ViceMeError } from '../core/errors.ts';
import type { CapabilityMountHandle, CapabilityMountOptions } from '../loader/mount-handle.ts';
import { SDK_VERSION } from '../version.ts';
import { readDanmakuPageAnchor, type DanmakuPageAnchor } from './anchor.ts';

type DanmakuFrameMode = 'stage' | 'controls' | 'modal';

interface DanmakuBridgeMessage {
  source?: unknown;
  action?: unknown;
  frameToken?: unknown;
  mode?: unknown;
  width?: unknown;
  height?: unknown;
}

const CONTROLS_MIN_SIZE = 32;
const CONTROLS_BAR_HEIGHT = 56;
const CONTROLS_MAX_HEIGHT = 360;
const CONTROLS_MAX_WIDTH = 480;
const ANCHOR_DEBOUNCE_MS = 120;
const LOCATION_POLL_MS = 1_000;
export const FRAME_READY_TIMEOUT_MS = 8_000;

export async function mount(
  client: ViceMeClient,
  options: CapabilityMountOptions,
): Promise<CapabilityMountHandle> {
  await client.ready();
  if (!client.hasCapability('danmaku')) {
    throw new ViceMeError({
      code: 'CAPABILITY_DISABLED',
      message: 'Danmaku is not available in this SDK build.',
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

  const widgetOrigin = BUILD_WIDGET_ORIGINS[client.region];
  let currentAnchor = readDanmakuPageAnchor(windowObject, documentObject);
  const locale =
    documentObject.documentElement.lang.trim() || windowObject.navigator.language || 'en';
  let destroyed = false;
  let anchorTimer: number | undefined;
  let readyTimer: number | undefined;
  let modalReadyTimer: number | undefined;
  let initialFramesReady = false;
  let modalAttempt = 0;
  let modalFrameToken = '';
  let modalReady = false;
  const loadedFrames = new WeakSet<HTMLIFrameElement>();
  const readyModes = new Set<DanmakuFrameMode>();

  const portal = documentObject.createElement('div');
  portal.dataset.vicemeDanmaku = 'mounted';
  portal.style.all = 'initial';
  portal.style.position = 'fixed';
  portal.style.inset = '0';
  portal.style.width = '100%';
  portal.style.height = '100%';
  portal.style.pointerEvents = 'none';
  portal.style.zIndex = '2147483000';
  portal.style.contain = 'layout style size';

  const shadow = portal.attachShadow({ mode: 'open' });
  const root = documentObject.createElement('div');
  root.style.boxSizing = 'border-box';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.pointerEvents = 'none';
  shadow.append(root);

  const frameUrl = (mode: DanmakuFrameMode): URL => {
    const url = new URL('/embed/danmaku', widgetOrigin);
    url.searchParams.set('mode', mode);
    url.searchParams.set('workKey', client.workKey);
    url.searchParams.set('theme', options.theme);
    url.searchParams.set('locale', locale);
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
    frame.style.boxSizing = 'border-box';
    frame.style.colorScheme = 'normal';
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
  controls.style.left = '50%';
  controls.style.bottom = 'env(safe-area-inset-bottom, 0px)';
  controls.style.maxWidth = `${CONTROLS_MAX_WIDTH}px`;
  controls.style.transform = 'translateX(-50%)';
  let controlsRequestedWidth = CONTROLS_MAX_WIDTH;
  let controlsRequestedHeight = CONTROLS_BAR_HEIGHT;
  const applyControlsSize = (): void => {
    const viewportWidth = Math.max(
      CONTROLS_MIN_SIZE,
      Math.floor(windowObject.innerWidth || CONTROLS_MAX_WIDTH),
    );
    controls.style.width = `${Math.min(controlsRequestedWidth, viewportWidth)}px`;
    controls.style.height = `${controlsRequestedHeight}px`;
  };
  applyControlsSize();
  controls.style.pointerEvents = 'none';

  const modal = createFrame('modal', 'ViceMe Danmaku dialog', 'about:blank');
  modal.dataset.src = frameUrl('modal').toString();
  modal.style.inset = '0';
  modal.style.height = '100%';
  modal.style.display = 'none';
  modal.style.pointerEvents = 'none';

  root.append(stage, controls, modal);

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
  const handleWindowResize = (): void => {
    applyControlsSize();
    scheduleAnchorRefresh();
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

  const hideModal = (resetFrame = false): void => {
    if (modalReadyTimer !== undefined) {
      windowObject.clearTimeout(modalReadyTimer);
      modalReadyTimer = undefined;
    }
    modal.style.display = 'none';
    modal.style.pointerEvents = 'none';
    if (resetFrame) {
      modalFrameToken = '';
      modalReady = false;
      loadedFrames.delete(modal);
      modal.src = 'about:blank';
    }
  };

  let resolveInitialFrames: (() => void) | undefined;
  const initialFrameReadiness = new Promise<void>((resolve, reject) => {
    resolveInitialFrames = resolve;
    readyTimer = windowObject.setTimeout(() => {
      reject(
        new ViceMeError({
          code: 'INTERNAL_ERROR',
          message: 'Hosted danmaku frames did not become ready in time.',
          retryable: true,
          capability: 'danmaku',
        }),
      );
    }, FRAME_READY_TIMEOUT_MS);
  });

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== widgetOrigin) return;
    const fromStage = event.source === stage.contentWindow;
    const fromControls = event.source === controls.contentWindow;
    const fromModal = event.source === modal.contentWindow;
    if (!fromStage && !fromControls && !fromModal) return;

    const message = event.data as DanmakuBridgeMessage | null;
    if (!message || message.source !== 'viceme-danmaku') return;

    const sourceMode: DanmakuFrameMode = fromModal ? 'modal' : fromStage ? 'stage' : 'controls';
    if (message.action === 'frame-ready') {
      if (message.mode !== sourceMode) return;
      if (sourceMode === 'modal') {
        if (message.frameToken !== modalFrameToken) return;
        modalReady = true;
        if (modalReadyTimer !== undefined) {
          windowObject.clearTimeout(modalReadyTimer);
          modalReadyTimer = undefined;
        }
        if (modal.style.display === 'block') modal.style.pointerEvents = 'auto';
        return;
      }
      readyModes.add(sourceMode);
      if (readyModes.has('stage') && readyModes.has('controls') && !initialFramesReady) {
        initialFramesReady = true;
        if (readyTimer !== undefined) {
          windowObject.clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        controls.style.pointerEvents = 'auto';
        resolveInitialFrames?.();
      }
      return;
    }
    if (message.action === 'resize-controls' && fromControls) {
      if (
        typeof message.width !== 'number' ||
        !Number.isInteger(message.width) ||
        message.width < CONTROLS_MIN_SIZE ||
        message.width > CONTROLS_MAX_WIDTH ||
        typeof message.height !== 'number' ||
        !Number.isInteger(message.height) ||
        message.height < CONTROLS_MIN_SIZE ||
        message.height > CONTROLS_MAX_HEIGHT
      ) {
        return;
      }
      controlsRequestedWidth = message.width;
      controlsRequestedHeight = message.height;
      applyControlsSize();
    }
    if (message.action === 'request-anchor') {
      postAnchor(fromModal ? modal : fromStage ? stage : controls);
    }
    if (message.action === 'open-modal' && fromControls) {
      if (!initialFramesReady) return;
      if (modal.getAttribute('src') === 'about:blank') {
        modalAttempt += 1;
        modalFrameToken = String(modalAttempt);
        const modalUrl = new URL(modal.dataset.src ?? 'about:blank');
        modalUrl.searchParams.set('frameToken', modalFrameToken);
        modal.src = modalUrl.toString();
      }
      modal.style.display = 'block';
      modal.style.pointerEvents = modalReady ? 'auto' : 'none';
      if (!modalReady) {
        if (modalReadyTimer !== undefined) windowObject.clearTimeout(modalReadyTimer);
        modalReadyTimer = windowObject.setTimeout(() => hideModal(true), FRAME_READY_TIMEOUT_MS);
      }
    }
    if (message.action === 'close-modal' && (fromModal || fromControls)) {
      hideModal(!modalReady);
    }
  };

  const locationPoll = windowObject.setInterval(refreshAnchor, LOCATION_POLL_MS);
  const cleanup = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (anchorTimer !== undefined) windowObject.clearTimeout(anchorTimer);
    if (readyTimer !== undefined) windowObject.clearTimeout(readyTimer);
    if (modalReadyTimer !== undefined) windowObject.clearTimeout(modalReadyTimer);
    windowObject.clearInterval(locationPoll);
    windowObject.removeEventListener('message', onMessage);
    windowObject.removeEventListener('scroll', scheduleAnchorRefresh);
    windowObject.removeEventListener('resize', handleWindowResize);
    windowObject.removeEventListener('popstate', scheduleAnchorRefresh);
    windowObject.removeEventListener('hashchange', scheduleAnchorRefresh);
    stage.removeEventListener('load', frameLoaded);
    controls.removeEventListener('load', frameLoaded);
    modal.removeEventListener('load', frameLoaded);
    portal.remove();
  };

  windowObject.addEventListener('message', onMessage);
  windowObject.addEventListener('scroll', scheduleAnchorRefresh, { passive: true });
  windowObject.addEventListener('resize', handleWindowResize);
  windowObject.addEventListener('popstate', scheduleAnchorRefresh);
  windowObject.addEventListener('hashchange', scheduleAnchorRefresh);
  try {
    options.target.appendChild(portal);
    postAnchorToMountedFrames();
    await initialFrameReadiness;
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    capability: 'danmaku',
    destroy: cleanup,
  };
}
