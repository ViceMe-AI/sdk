import type { ViceMeClient } from '../core/client.ts';
import { BUILD_WIDGET_ORIGINS } from '../core/build-endpoints.ts';
import { clientDestroyed, ViceMeError } from '../core/errors.ts';
import { dispatchViceMeEvent } from '../browser-events.ts';
import type { CapabilityMountHandle, CapabilityMountOptions } from '../capability-mount.ts';

type WidgetAppearance = 'light' | 'dark';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIP_ORDER_NO_PATTERN = /^VT\d{14}[0-9a-f]{12}$/;
const TIP_AMOUNT_MIN = 100;
const TIP_AMOUNT_MAX = 20_000;
const WIDGET_HEIGHT_MAX = 2_048;
export const FRAME_READY_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  const mediaQuery =
    options.theme === 'auto' ? windowObject.matchMedia('(prefers-color-scheme: dark)') : undefined;
  let appearance: WidgetAppearance =
    options.theme === 'auto' ? (mediaQuery?.matches ? 'dark' : 'light') : options.theme;
  let destroyed = false;
  let readyTimer: number | undefined;
  let boundWorkId: string | undefined;

  const portal = documentObject.createElement('div');
  portal.dataset.vicemeTip = 'mounted';
  portal.style.all = 'initial';
  portal.style.display = 'block';
  portal.style.width = '100%';
  portal.style.maxWidth = '100%';
  portal.style.contain = 'layout style';

  const shadow = portal.attachShadow({ mode: 'open' });
  const frame = documentObject.createElement('iframe');
  const frameUrl = new URL(`/widget/tip/${encodeURIComponent(client.workKey)}`, widgetOrigin);
  frameUrl.searchParams.set('appearance', appearance);
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
  frame.style.height = '0px';
  frame.style.margin = '0';
  frame.style.border = '0';
  frame.style.background = 'transparent';
  frame.style.colorScheme = appearance;
  frame.style.pointerEvents = 'none';
  shadow.append(frame);

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
    if (!isRecord(message) || typeof message.type !== 'string') return;

    if (message.type === 'viceme:widget-resize') {
      if (
        typeof message.workId !== 'string' ||
        !UUID_PATTERN.test(message.workId) ||
        typeof message.height !== 'number' ||
        !Number.isInteger(message.height) ||
        message.height < 1 ||
        message.height > WIDGET_HEIGHT_MAX ||
        (boundWorkId !== undefined && message.workId !== boundWorkId)
      ) {
        return;
      }
      frame.style.height = `${message.height}px`;
      if (boundWorkId === undefined) {
        boundWorkId = message.workId;
        frame.style.pointerEvents = 'auto';
        if (readyTimer !== undefined) {
          windowObject.clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        resolveReady?.();
      }
      return;
    }

    if (typeof message.workId !== 'string' || message.workId !== boundWorkId) return;
    if (message.type === 'viceme:widget-close') {
      dispatchViceMeEvent(options.target, 'viceme:widget-close', { workId: message.workId });
      return;
    }
    if (
      message.type === 'viceme:tip-paid' &&
      typeof message.orderNo === 'string' &&
      TIP_ORDER_NO_PATTERN.test(message.orderNo) &&
      message.status === 'PAID' &&
      typeof message.amountCents === 'number' &&
      Number.isInteger(message.amountCents) &&
      message.amountCents >= TIP_AMOUNT_MIN &&
      message.amountCents <= TIP_AMOUNT_MAX
    ) {
      dispatchViceMeEvent(options.target, 'viceme:tip-paid', {
        workId: message.workId,
        orderNo: message.orderNo,
        status: 'PAID',
        amountCents: message.amountCents,
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
  } catch (error) {
    cleanup();
    throw error;
  }

  return { capability: 'tip', destroy: cleanup };
}
