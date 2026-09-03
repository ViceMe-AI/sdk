import type { ViceMeClient } from '../core/client.ts';
import { BUILD_WIDGET_ORIGINS } from '../core/build-endpoints.ts';
import { clientDestroyed, ViceMeError } from '../core/errors.ts';
import { dispatchViceMeEvent } from '../browser-events.ts';
import type { CapabilityMountHandle, CapabilityMountOptions } from '../capability-mount.ts';
import { isValidTipWorkTitle } from './validation.ts';
import { focusIntegratedDanmaku, registerIntegratedTip } from '../engagement/integration.ts';

type WidgetAppearance = 'light' | 'dark';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIP_AMOUNT_MIN = 100;
const TIP_AMOUNT_MAX = 20_000;
const WIDGET_HEIGHT_MAX = 2_048;
export const FRAME_READY_TIMEOUT_MS = 8_000;
const RESIZE_MESSAGE_KEYS = ['type', 'workId', 'work', 'height'];
const CLOSE_MESSAGE_KEYS = ['type', 'workId'];
const PAID_MESSAGE_KEYS = ['type', 'workKey', 'status', 'work', 'amountCents', 'currency'];
const WORK_KEYS = ['id', 'title'];

function isStrictRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

export async function mount(
  client: ViceMeClient,
  options: CapabilityMountOptions,
): Promise<CapabilityMountHandle> {
  if (options.signal?.aborted) throw clientDestroyed();
  await client.ready();
  if (options.signal?.aborted) throw clientDestroyed();
  if (!client.hasCapability('tip')) {
    throw new ViceMeError({
      code: 'CAPABILITY_DISABLED',
      message: 'Tip is not available in this SDK build.',
      retryable: false,
      capability: 'tip',
    });
  }
  if (client.region !== 'cn') {
    throw new ViceMeError({
      code: 'CAPABILITY_DISABLED',
      message: 'Tip is not available in this region.',
      retryable: false,
      capability: 'tip',
    });
  }
  const documentObject = options.target.ownerDocument;
  const windowObject = documentObject.defaultView;
  if (!windowObject) {
    throw new ViceMeError({
      code: 'CONFIG_INVALID',
      message: 'Tip requires a browser document.',
      retryable: false,
      capability: 'tip',
    });
  }

  const widgetOrigin = BUILD_WIDGET_ORIGINS[client.region];
  const integrated = options.presentation === 'integrated';
  const mediaQuery =
    options.theme === 'auto' ? windowObject.matchMedia('(prefers-color-scheme: dark)') : undefined;
  let appearance: WidgetAppearance =
    options.theme === 'auto' ? (mediaQuery?.matches ? 'dark' : 'light') : options.theme;
  let destroyed = false;
  let readyTimer: number | undefined;
  let boundWork: { id: string; title: string } | undefined;
  let opened = false;
  let unregisterIntegration: (() => void) | undefined;

  const portal = documentObject.createElement('div');
  portal.dataset.vicemeTip = 'mounted';
  portal.style.all = 'initial';
  portal.style.display = integrated ? 'none' : 'block';
  portal.style.width = '100%';
  portal.style.maxWidth = '100%';
  portal.style.contain = integrated ? 'layout style size' : 'layout style';
  if (integrated) {
    portal.style.position = 'fixed';
    portal.style.inset = '0';
    portal.style.height = '100%';
    portal.style.pointerEvents = 'none';
    portal.style.zIndex = '2147483001';
  }

  const shadow = portal.attachShadow({ mode: 'open' });
  const frame = documentObject.createElement('iframe');
  const frameUrl = new URL(`/widget/tip/${encodeURIComponent(client.workKey)}`, widgetOrigin);
  frameUrl.searchParams.set('appearance', appearance);
  if (integrated) frameUrl.searchParams.set('mode', 'dialog');
  frame.title = 'ViceMe Tip';
  frame.src = frameUrl.toString();
  frame.loading = 'eager';
  frame.referrerPolicy = 'strict-origin';
  frame.setAttribute(
    'sandbox',
    'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
  );
  frame.setAttribute('allow', 'payment');
  frame.style.boxSizing = 'border-box';
  frame.style.display = 'block';
  frame.style.width = '100%';
  frame.style.height = integrated ? '100%' : '0px';
  frame.style.margin = '0';
  frame.style.border = '0';
  frame.style.background = 'transparent';
  frame.style.colorScheme = appearance;
  frame.style.pointerEvents = 'none';
  shadow.append(frame);

  const openIntegrated = (): void => {
    if (destroyed || !boundWork) return;
    opened = true;
    portal.style.display = 'block';
    portal.style.pointerEvents = 'auto';
    frame.style.pointerEvents = 'auto';
    frame.contentWindow?.postMessage(
      { type: 'viceme:widget-open', workId: boundWork.id },
      widgetOrigin,
    );
  };

  const hideIntegrated = (restoreFocus: boolean): void => {
    if (!integrated) return;
    const wasOpen = opened;
    opened = false;
    portal.style.display = 'none';
    portal.style.pointerEvents = 'none';
    frame.style.pointerEvents = 'none';
    if (restoreFocus && wasOpen) focusIntegratedDanmaku(client, options.target);
  };

  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: ViceMeError) => void) | undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    readyTimer = windowObject.setTimeout(() => {
      reject(
        new ViceMeError({
          code: 'INTERNAL_ERROR',
          message: 'Hosted Tip widget did not become ready in time.',
          retryable: true,
          capability: 'tip',
        }),
      );
    }, FRAME_READY_TIMEOUT_MS);
  });

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.origin !== widgetOrigin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;

    if (isStrictRecord(message, RESIZE_MESSAGE_KEYS) && message.type === 'viceme:widget-resize') {
      if (
        typeof message.workId !== 'string' ||
        !UUID_PATTERN.test(message.workId) ||
        !isStrictRecord(message.work, WORK_KEYS) ||
        message.work.id !== message.workId ||
        !isValidTipWorkTitle(message.work.title) ||
        typeof message.height !== 'number' ||
        !Number.isInteger(message.height) ||
        message.height < 1 ||
        message.height > WIDGET_HEIGHT_MAX ||
        (boundWork !== undefined &&
          (message.work.id !== boundWork.id || message.work.title !== boundWork.title))
      ) {
        return;
      }
      if (!integrated) frame.style.height = `${message.height}px`;
      if (boundWork === undefined) {
        boundWork = { id: message.workId, title: message.work.title };
        if (!integrated) frame.style.pointerEvents = 'auto';
        if (readyTimer !== undefined) {
          windowObject.clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        resolveReady?.();
      }
      return;
    }

    if (isStrictRecord(message, CLOSE_MESSAGE_KEYS) && message.type === 'viceme:widget-close') {
      if (typeof message.workId !== 'string' || message.workId !== boundWork?.id) return;
      hideIntegrated(true);
      dispatchViceMeEvent(options.target, 'viceme:widget-close', { workId: message.workId });
      return;
    }
    if (
      isStrictRecord(message, PAID_MESSAGE_KEYS) &&
      message.type === 'viceme:tip-paid' &&
      message.workKey === client.workKey &&
      isStrictRecord(message.work, WORK_KEYS) &&
      boundWork !== undefined &&
      typeof message.work.id === 'string' &&
      message.work.id === boundWork.id &&
      isValidTipWorkTitle(message.work.title) &&
      message.work.title === boundWork.title &&
      message.status === 'PAID' &&
      typeof message.amountCents === 'number' &&
      Number.isInteger(message.amountCents) &&
      message.amountCents >= TIP_AMOUNT_MIN &&
      message.amountCents <= TIP_AMOUNT_MAX &&
      message.currency === 'CNY'
    ) {
      dispatchViceMeEvent(options.target, 'viceme:tip-paid', {
        status: 'PAID',
        work: { id: message.work.id, title: message.work.title },
        amountCents: message.amountCents,
        currency: 'CNY',
      });
    }
  };

  const onAppearanceChange = (event: MediaQueryListEvent): void => {
    appearance = event.matches ? 'dark' : 'light';
    frame.style.colorScheme = appearance;
    frame.contentWindow?.postMessage(
      { type: 'viceme:widget-appearance', appearance },
      widgetOrigin,
    );
  };

  let removeAppearanceListener: (() => void) | undefined;
  const onAbort = (): void => {
    rejectReady?.(clientDestroyed());
    cleanup();
  };
  const cleanup = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (readyTimer !== undefined) windowObject.clearTimeout(readyTimer);
    windowObject.removeEventListener('message', onMessage);
    removeAppearanceListener?.();
    const restoreFocus = opened;
    hideIntegrated(false);
    unregisterIntegration?.();
    unregisterIntegration = undefined;
    if (restoreFocus) focusIntegratedDanmaku(client, options.target);
    options.signal?.removeEventListener('abort', onAbort);
    portal.remove();
  };

  try {
    windowObject.addEventListener('message', onMessage);
    if (mediaQuery) {
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', onAppearanceChange);
        removeAppearanceListener = () =>
          mediaQuery.removeEventListener('change', onAppearanceChange);
      } else {
        mediaQuery.addListener(onAppearanceChange);
        removeAppearanceListener = () => mediaQuery.removeListener(onAppearanceChange);
      }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) throw clientDestroyed();
    options.target.appendChild(portal);
    await readiness;
    if (destroyed || options.signal?.aborted) throw clientDestroyed();
    if (integrated) {
      unregisterIntegration = registerIntegratedTip(client, options.target, {
        open: openIntegrated,
      });
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return { capability: 'tip', destroy: cleanup };
}
