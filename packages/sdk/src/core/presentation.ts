export type AccessInteractionAction = 'SIGN_IN' | 'FOLLOW' | 'CHECKOUT';

export interface AccessInteraction {
  featureKey: string;
  reason: string;
  action: AccessInteractionAction;
  perform(): Promise<AccessActionResult>;
}

export interface AccessCompletedAction {
  type: 'completed';
}

export interface AccessFrameAction {
  type: 'frame';
  url: string;
  completion: Promise<void>;
  cancel(): void;
}

export type AccessActionResult = AccessCompletedAction | AccessFrameAction;

export type AccessPresentationResult = 'acted' | 'dismissed';

/**
 * Site-owned presenters can wrap the headless SDK with an existing React or
 * HTML Sheet/Drawer. When omitted, the SDK uses its lightweight Web Component.
 */
export type AccessPresenter = (interaction: AccessInteraction) => Promise<AccessPresentationResult>;

const ELEMENT_NAME = 'viceme-access-layer';

interface AccessLayerElement extends HTMLElement {
  interaction: AccessInteraction;
}

function actionCopy(action: AccessInteractionAction): {
  title: string;
  description: string;
  label: string;
} {
  switch (action) {
    case 'SIGN_IN':
      return {
        title: '登录后继续',
        description: '登录 ViceMe 后即可继续检查此功能权限。',
        label: '微信登录',
      };
    case 'FOLLOW':
      return {
        title: '关注创作者',
        description: '请在此界面确认关注创作者，关注成功后将重新检查权限。',
        label: '关注创作者',
      };
    case 'CHECKOUT':
      return {
        title: '购买后解锁',
        description: '在当前页面查看作品并完成支付，成功后将自动返回。',
        label: '打开支付',
      };
  }
}

function ensureAccessLayerElement(): void {
  if (customElements.get(ELEMENT_NAME)) return;

  class ViceMeAccessLayerElement extends HTMLElement implements AccessLayerElement {
    interaction!: AccessInteraction;

    connectedCallback(): void {
      const copy = actionCopy(this.interaction.action);
      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host {
            --viceme-layer-backdrop: rgb(15 23 42 / 42%);
            --viceme-layer-surface: Canvas;
            --viceme-layer-text: CanvasText;
            --viceme-layer-muted: color-mix(in srgb, CanvasText 62%, transparent);
            --viceme-layer-accent: CanvasText;
            position: fixed;
            inset: 0;
            z-index: 2147483000;
            display: grid;
            align-items: end;
            color: var(--viceme-layer-text);
            font: inherit;
          }
          [part='backdrop'] {
            position: absolute;
            inset: 0;
            border: 0;
            background: var(--viceme-layer-backdrop);
          }
          [part='panel'] {
            position: relative;
            box-sizing: border-box;
            width: 100%;
            max-height: min(78vh, 36rem);
            overflow: auto;
            border-radius: 1.25rem 1.25rem 0 0;
            background: var(--viceme-layer-surface);
            color: var(--viceme-layer-text);
            padding: 0.75rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));
            box-shadow: 0 -1rem 3rem rgb(15 23 42 / 18%);
          }
          [part='frame-header'] { display: none; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
          [part='frame-title'] { margin: 0; font: inherit; font-size: 1em; font-weight: 650; }
          [part='frame-close'] { min-width: 2.75rem; padding: 0.5rem; }
          [part='frame'] { display: none; width: 100%; height: min(72dvh, 42rem); border: 0; border-radius: 0.75rem; background: Canvas; }
          [part='panel'][data-frame='true'] { max-height: 92dvh; }
          [part='panel'][data-frame='true'] [part='handle'],
          [part='panel'][data-frame='true'] > [part='title'],
          [part='panel'][data-frame='true'] > [part='description'],
          [part='panel'][data-frame='true'] > [part='error'],
          [part='panel'][data-frame='true'] > [part='actions'] { display: none; }
          [part='panel'][data-frame='true'] [part='frame-header'] { display: flex; }
          [part='panel'][data-frame='true'] [part='frame'] { display: block; }
          [part='handle'] {
            width: 2.5rem;
            height: 0.25rem;
            margin: 0 auto 1rem;
            border-radius: 999px;
            background: color-mix(in srgb, CanvasText 20%, transparent);
          }
          [part='title'] { margin: 0; font: inherit; font-size: 1.125em; font-weight: 650; }
          [part='description'] { margin: 0.5rem 0 1.25rem; color: var(--viceme-layer-muted); line-height: 1.6; }
          [part='actions'] { display: grid; gap: 0.75rem; }
          button { min-height: 2.75rem; border-radius: 0.75rem; padding: 0.625rem 1rem; font: inherit; cursor: pointer; }
          [part='action'] { border: 1px solid var(--viceme-layer-accent); background: var(--viceme-layer-accent); color: Canvas; font-weight: 600; }
          [part='dismiss'] { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); background: transparent; color: inherit; }
          button:disabled { cursor: wait; opacity: 0.58; }
          [part='error'] { min-height: 1.25rem; margin: 0 0 0.75rem; color: #b42318; font-size: 0.875em; }
          @media (min-width: 48rem) {
            :host { place-items: center; padding: 1.5rem; }
            [part='panel'] { width: min(28rem, 100%); border-radius: 1.25rem; padding: 1.25rem; box-shadow: 0 1.5rem 4rem rgb(15 23 42 / 24%); }
            [part='panel'][data-frame='true'] { width: min(42rem, 100%); }
            [part='handle'] { display: none; }
          }
          @media (prefers-reduced-motion: no-preference) {
            [part='panel'] { animation: viceme-enter 160ms ease-out; }
            @keyframes viceme-enter { from { opacity: 0; transform: translateY(1rem); } }
          }
        </style>
        <button part="backdrop" type="button" tabindex="-1" aria-label="关闭"></button>
        <section part="panel" role="dialog" aria-modal="true" aria-labelledby="viceme-layer-title">
          <div part="handle" aria-hidden="true"></div>
          <h2 part="title" id="viceme-layer-title"></h2>
          <p part="description"></p>
          <p part="error" role="alert" aria-live="polite"></p>
          <div part="actions">
            <button part="action" type="button"></button>
            <button part="dismiss" type="button">暂不操作</button>
          </div>
          <div part="frame-header">
            <p part="frame-title"></p>
            <button part="frame-close" type="button" aria-label="关闭">关闭</button>
          </div>
          <iframe part="frame" title="" referrerpolicy="no-referrer" allow="payment"></iframe>
        </section>
      `;
      shadow.querySelector<HTMLElement>("[part='title']")!.textContent = copy.title;
      shadow.querySelector<HTMLElement>("[part='description']")!.textContent = copy.description;
      const action = shadow.querySelector<HTMLButtonElement>("[part='action']")!;
      const dismiss = shadow.querySelector<HTMLButtonElement>("[part='dismiss']")!;
      const backdrop = shadow.querySelector<HTMLButtonElement>("[part='backdrop']")!;
      const error = shadow.querySelector<HTMLElement>("[part='error']")!;
      const panel = shadow.querySelector<HTMLElement>("[part='panel']")!;
      const frameTitle = shadow.querySelector<HTMLElement>("[part='frame-title']")!;
      const frameClose = shadow.querySelector<HTMLButtonElement>("[part='frame-close']")!;
      const frame = shadow.querySelector<HTMLIFrameElement>("[part='frame']")!;
      action.textContent = copy.label;
      frameTitle.textContent = copy.title;
      frame.title = copy.title;
      let activeFrame: AccessFrameAction | null = null;

      const close = (result: AccessPresentationResult) => {
        this.dispatchEvent(new CustomEvent('viceme:access-layer-close', { detail: result }));
      };
      const dismissLayer = () => {
        activeFrame?.cancel();
        close('dismissed');
      };
      dismiss.addEventListener('click', dismissLayer);
      backdrop.addEventListener('click', dismissLayer);
      frameClose.addEventListener('click', dismissLayer);
      this.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') dismissLayer();
        if (event.key === 'Tab') {
          event.preventDefault();
          if (activeFrame) {
            frameClose.focus();
            return;
          }
          const next = event.shiftKey
            ? shadow.activeElement === action
              ? dismiss
              : action
            : shadow.activeElement === dismiss
              ? action
              : dismiss;
          next.focus();
        }
      });
      action.addEventListener('click', async () => {
        action.disabled = true;
        dismiss.disabled = true;
        error.textContent = '';
        try {
          const result = await this.interaction.perform();
          if (result.type === 'frame') {
            activeFrame = result;
            panel.dataset.frame = 'true';
            frame.src = result.url;
            frameClose.focus();
            await result.completion;
          }
          close('acted');
        } catch {
          activeFrame?.cancel();
          activeFrame = null;
          panel.dataset.frame = 'false';
          frame.removeAttribute('src');
          error.textContent = '操作未完成，请重试。';
          action.disabled = false;
          dismiss.disabled = false;
          action.focus();
        }
      });
      queueMicrotask(() => action.focus());
    }
  }

  customElements.define(ELEMENT_NAME, ViceMeAccessLayerElement);
}

export const defaultAccessPresenter: AccessPresenter = async (interaction) => {
  if (typeof document === 'undefined' || typeof customElements === 'undefined') {
    return 'dismissed';
  }
  ensureAccessLayerElement();
  const element = document.createElement(ELEMENT_NAME) as AccessLayerElement;
  element.interaction = interaction;
  const previousOverflow = document.documentElement.style.overflow;
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.documentElement.style.overflow = 'hidden';
  document.body.append(element);
  try {
    return await new Promise<AccessPresentationResult>((resolve) => {
      element.addEventListener(
        'viceme:access-layer-close',
        (event) => resolve((event as CustomEvent<AccessPresentationResult>).detail),
        { once: true },
      );
    });
  } finally {
    element.remove();
    document.documentElement.style.overflow = previousOverflow;
    previousFocus?.focus();
  }
};
