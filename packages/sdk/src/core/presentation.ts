import type { FollowTarget } from './capabilities.ts';
import { isViceMeError } from './errors.ts';

export type AccessInteractionAction = 'SIGN_IN' | 'CHECKOUT';

export interface AccessInteraction {
  featureKey: string;
  reason: string;
  action: AccessInteractionAction;
  followTarget?: FollowTarget;
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

/** Internal interaction seam used by the ViceMe layer and deterministic tests. */
export type AccessPresenter = (interaction: AccessInteraction) => Promise<AccessPresentationResult>;

const ELEMENT_NAME = 'viceme-access-layer';

interface AccessLayerElement extends HTMLElement {
  interaction: AccessInteraction;
}

function actionCopy(action: AccessInteractionAction): {
  description: string;
  label: string;
} {
  switch (action) {
    case 'SIGN_IN':
      return {
        description: '',
        label: '登录',
      };
    case 'CHECKOUT':
      return {
        description: '',
        label: '重新打开',
      };
  }
}

function actionErrorCopy(error: unknown): string {
  if (!isViceMeError(error)) return '操作未完成，请重试。';
  switch (error.code) {
    case 'CONFIG_INVALID':
      return '微信授权配置无效，请稍后重试。';
    case 'AUTH_CANCELLED':
      return '微信授权已取消，请重试。';
    case 'SESSION_EXPIRED':
      return '授权会话已过期，请重试。';
    case 'NETWORK_TIMEOUT':
      return '网络连接超时，请重试。';
    default:
      return error.requestId
        ? `操作未完成，请重试。请求 ID：${error.requestId}`
        : '操作未完成，请重试。';
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
            position: fixed;
            inset: 0;
            z-index: 2147483000;
            display: grid;
            align-items: end;
            color: #18181b;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            font-size: 16px;
            line-height: 1.5;
          }
          [data-viceme='backdrop'] {
            position: absolute;
            inset: 0;
            border: 0;
            border-radius: 0;
            background: rgb(0 0 0 / 56%);
          }
          [data-viceme='panel'] {
            position: relative;
            box-sizing: border-box;
            display: flex;
            width: 100%;
            min-height: min(32rem, calc(100dvh - 2rem));
            max-height: min(92dvh, 46rem);
            flex-direction: column;
            overflow: auto;
            border-radius: 1.25rem 1.25rem 0 0;
            background: #ffffff;
            color: #18181b;
            padding: 1rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));
            box-shadow: 0 -1rem 3rem rgb(0 0 0 / 18%);
          }
          [data-viceme='content'] { display: flex; min-height: 0; flex: 1; flex-direction: column; }
          [data-viceme='description'] { margin: 0.75rem 0 1.25rem; color: #71717a; line-height: 1.6; }
          [data-viceme='profile'] {
            display: none;
            margin: 0 0 1.25rem;
            border: 1px solid #e4e4e7;
            border-radius: 1rem;
            padding: 1.5rem;
            background: #ffffff;
            box-shadow: 0 0.75rem 2rem rgb(0 0 0 / 6%);
            text-align: center;
          }
          [data-viceme='profile'][data-visible='true'] { display: block; }
          [data-viceme='avatar'] {
            display: block;
            width: 5.5rem;
            height: 5.5rem;
            margin: 0 auto 1rem;
            border-radius: 999px;
            object-fit: cover;
            background: #f4f4f5;
          }
          [data-viceme='avatar-fallback'] {
            display: grid;
            width: 5.5rem;
            height: 5.5rem;
            margin: 0 auto 1rem;
            place-items: center;
            border-radius: 999px;
            background: #f4f4f5;
            color: #18181b;
            font-size: 2rem;
            font-weight: 700;
          }
          [data-viceme='avatar'][hidden], [data-viceme='avatar-fallback'][hidden] { display: none; }
          [data-viceme='profile-name'] { margin: 0; font-size: 1.375rem; font-weight: 700; }
          [data-viceme='profile-description'] {
            margin: 0.25rem 0 0;
            overflow-wrap: anywhere;
            color: #71717a;
          }
          [data-viceme='profile-header'] { min-width: 0; }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='description'] { display: none; }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='profile'][data-visible='true'] {
            display: block;
            margin: 0;
            border: 0;
            padding: 0;
            background: transparent;
            box-shadow: none;
            text-align: left;
          }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='profile-header'] {
            display: flex;
            align-items: center;
            gap: 0.875rem;
          }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='avatar'],
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='avatar-fallback'] {
            width: 3.25rem;
            height: 3.25rem;
            margin: 0;
            flex: 0 0 3.25rem;
            font-size: 1.25rem;
          }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='profile-name'] {
            font-size: 1.125rem;
          }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='profile-description'] {
            margin-top: 0.875rem;
            line-height: 1.625;
          }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='actions'] {
            justify-content: stretch;
          }
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='secondary-action'],
          [data-viceme='panel'][data-action='SIGN_IN'] [data-viceme='action'] {
            width: auto;
            flex: 1 1 0;
          }
          [data-viceme='actions'] {
            display: flex;
            justify-content: flex-end;
            gap: 0.75rem;
            margin-top: auto;
            padding-top: 0.5rem;
          }
          button {
            box-sizing: border-box;
            display: inline-flex;
            height: 3.25rem;
            align-items: center;
            justify-content: center;
            border-radius: 0.75rem;
            padding: 0.625rem 1rem;
            font: 600 1rem/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            cursor: pointer;
          }
          button:focus-visible, iframe:focus-visible { outline: 2px solid #18181b; outline-offset: 2px; }
          [data-viceme='action'] {
            width: min(11rem, 48%);
            border: 1px solid #18181b;
            background: #18181b;
            color: #ffffff;
          }
          [data-viceme='secondary-action'] {
            width: min(11rem, 48%);
            border: 1px solid #18181b;
            background: #ffffff;
            color: #18181b;
          }
          [data-viceme='secondary-action']:hover { background: #f4f4f5; }
          [data-viceme='action']:hover { background: #3f3f46; border-color: #3f3f46; }
          [data-viceme='actions'][data-single='true'] [data-viceme='action'] { width: 100%; }
          button:disabled { cursor: wait; opacity: 0.5; }
          button[hidden] { display: none; }
          [data-viceme='error'] { min-height: 1.25rem; margin: 0 0 0.75rem; color: #b91c1c; font-size: 0.875rem; }
          [data-viceme='frame'] {
            display: none;
            width: 100%;
            height: min(82dvh, 44rem);
            border: 0;
            border-radius: 0.75rem;
            background: #ffffff;
          }
          [data-viceme='panel'][data-frame='true'] { max-height: 92dvh; }
          [data-viceme='panel'][data-frame='true'] [data-viceme='content'] { display: none; }
          [data-viceme='panel'][data-frame='true'] [data-viceme='frame'] { display: block; }
          [data-viceme='panel'][data-action='SIGN_IN'][data-frame='true'] [data-viceme='frame'] {
            height: min(72dvh, 34rem);
          }
          @media (min-width: 48rem) {
            :host { place-items: center; padding: 1.5rem; }
            [data-viceme='panel'] {
              width: min(24rem, 100%);
              border-radius: 1.25rem;
              padding: 1.25rem;
              box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 24%);
            }
            [data-viceme='panel'][data-frame='true'] { width: min(30rem, 100%); }
            [data-viceme='panel'][data-action='SIGN_IN'][data-frame='true'] { width: min(26rem, 100%); }
          }
          @media (prefers-reduced-motion: no-preference) {
            [data-viceme='panel'] { animation: viceme-enter 160ms ease-out; }
            @keyframes viceme-enter { from { opacity: 0; transform: translateY(1rem); } }
          }
        </style>
        <button data-viceme="backdrop" type="button" tabindex="-1" aria-label="关闭"></button>
        <section data-viceme="panel" role="dialog" aria-modal="true" aria-label="ViceMe 授权">
          <div data-viceme="content">
            <p data-viceme="description"></p>
            <section data-viceme="profile" aria-label="关注对象">
              <div data-viceme="profile-header">
                <img data-viceme="avatar" hidden />
                <span data-viceme="avatar-fallback" aria-hidden="true"></span>
                <p data-viceme="profile-name"></p>
              </div>
              <p data-viceme="profile-description"></p>
            </section>
            <p data-viceme="error" role="alert" aria-live="polite"></p>
            <div data-viceme="actions">
              <button data-viceme="secondary-action" data-viceme-cancel type="button">取消</button>
              <button data-viceme="action" type="button"></button>
            </div>
          </div>
          <iframe data-viceme="frame" title="" referrerpolicy="no-referrer" allow="payment"></iframe>
        </section>
      `;
      const panel = shadow.querySelector<HTMLElement>("[data-viceme='panel']")!;
      panel.dataset.action = this.interaction.action;
      const description = shadow.querySelector<HTMLElement>("[data-viceme='description']")!;
      description.textContent = copy.description;
      const action = shadow.querySelector<HTMLButtonElement>("[data-viceme='action']")!;
      const mainActions = action.parentElement!;
      const cancelAction = shadow.querySelector<HTMLButtonElement>('[data-viceme-cancel]')!;
      const backdrop = shadow.querySelector<HTMLButtonElement>("[data-viceme='backdrop']")!;
      const error = shadow.querySelector<HTMLElement>("[data-viceme='error']")!;
      const frame = shadow.querySelector<HTMLIFrameElement>("[data-viceme='frame']")!;
      const profile = shadow.querySelector<HTMLElement>("[data-viceme='profile']")!;
      const avatar = shadow.querySelector<HTMLImageElement>("[data-viceme='avatar']")!;
      const avatarFallback = shadow.querySelector<HTMLElement>("[data-viceme='avatar-fallback']")!;
      const profileName = shadow.querySelector<HTMLElement>("[data-viceme='profile-name']")!;
      const profileDescription = shadow.querySelector<HTMLElement>(
        "[data-viceme='profile-description']",
      )!;
      action.textContent = copy.label;
      action.hidden = this.interaction.action === 'CHECKOUT';
      cancelAction.hidden = this.interaction.action === 'CHECKOUT';
      cancelAction.textContent = this.interaction.action === 'SIGN_IN' ? '拒绝' : '取消';
      mainActions.dataset.single = String(cancelAction.hidden);
      const idleActionLabel = copy.label;
      frame.title = this.interaction.action === 'SIGN_IN' ? '微信授权' : '支付';

      const target = this.interaction.followTarget;
      if (target) {
        panel.setAttribute(
          'aria-label',
          this.interaction.action === 'SIGN_IN'
            ? `接受 ${target.displayName} 的授权`
            : `关注 ${target.displayName}`,
        );
        profile.dataset.visible = 'true';
        profileName.textContent = target.displayName;
        profileDescription.textContent = target.description ?? '接受登录授权后将自动关注该创作者。';
        avatarFallback.textContent = target.displayName.trim().slice(0, 1) || 'V';
        if (target.avatarUrl) {
          avatar.src = target.avatarUrl;
          avatar.alt = `${target.displayName}的头像`;
          avatar.hidden = false;
          avatarFallback.hidden = true;
        }
      }

      let activeFrame: AccessFrameAction | null = null;
      let activeFrameOrigin: string | null = null;
      const resizeFrame = (event: MessageEvent) => {
        if (
          !activeFrame ||
          !activeFrameOrigin ||
          event.source !== frame.contentWindow ||
          event.origin !== activeFrameOrigin ||
          typeof event.data !== 'object' ||
          event.data === null
        ) {
          return;
        }
        const data = event.data as Record<string, unknown>;
        if (
          data.type !== 'viceme:frame:resize' ||
          typeof data.height !== 'number' ||
          !Number.isFinite(data.height)
        ) {
          return;
        }
        const maximum = Math.max(240, Math.floor(window.innerHeight * 0.86));
        frame.style.height = `${Math.min(maximum, Math.max(240, Math.ceil(data.height)))}px`;
      };
      window.addEventListener('message', resizeFrame);
      const close = (result: AccessPresentationResult) => {
        window.removeEventListener('message', resizeFrame);
        this.dispatchEvent(new CustomEvent('viceme:access-layer-close', { detail: result }));
      };
      const dismissLayer = () => {
        activeFrame?.cancel();
        close('dismissed');
      };
      backdrop.addEventListener('click', dismissLayer);
      cancelAction.addEventListener('click', dismissLayer);
      this.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') dismissLayer();
        if (event.key === 'Tab') {
          event.preventDefault();
          if (activeFrame) {
            frame.focus();
            return;
          }
          const focusable = [
            ...(cancelAction.hidden ? [] : [cancelAction]),
            ...(action.hidden ? [] : [action]),
          ];
          const available = focusable.filter((element) => !element.disabled && !element.hidden);
          if (available.length === 0) return;
          const currentIndex = available.indexOf(shadow.activeElement as HTMLButtonElement);
          const direction = event.shiftKey ? -1 : 1;
          available[(currentIndex + direction + available.length) % available.length]?.focus();
        }
      });
      const performAction = async () => {
        action.disabled = true;
        action.setAttribute('aria-busy', 'true');
        action.textContent = '正在打开…';
        error.textContent = '';
        try {
          const result = await this.interaction.perform();
          if (result.type === 'frame') {
            activeFrame = result;
            activeFrameOrigin = new URL(result.url, window.location.href).origin;
            panel.dataset.frame = 'true';
            frame.src = result.url;
            frame.focus();
            await result.completion;
          }
          close('acted');
        } catch (caught) {
          activeFrame?.cancel();
          activeFrame = null;
          activeFrameOrigin = null;
          panel.dataset.frame = 'false';
          frame.style.removeProperty('height');
          frame.removeAttribute('src');
          error.textContent = actionErrorCopy(caught);
          action.hidden = false;
          action.disabled = false;
          action.removeAttribute('aria-busy');
          action.textContent = idleActionLabel;
          action.focus();
        }
      };
      action.addEventListener('click', performAction);
      if (this.interaction.action === 'CHECKOUT') {
        queueMicrotask(() => void performAction());
      } else {
        queueMicrotask(() => action.focus());
      }
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
