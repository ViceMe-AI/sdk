import type { FollowTarget } from './capabilities.ts';

export type AccessInteractionAction = 'SIGN_IN' | 'FOLLOW' | 'CHECKOUT';

export interface PhoneAuthInteraction {
  sendCode(phone: string): Promise<{
    expiresInSeconds: number;
    retryAfterSeconds: number;
  }>;
  signIn(phone: string, code: string): Promise<void>;
}

export interface AccessInteraction {
  featureKey: string;
  reason: string;
  action: AccessInteractionAction;
  followTarget?: FollowTarget;
  phoneAuth?: PhoneAuthInteraction;
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
        title: '关注后解锁',
        description: '关注后即可继续使用此功能。',
        label: '关注',
      };
    case 'CHECKOUT':
      return {
        title: '购买后解锁',
        description: '完成支付后即可继续使用此功能。',
        label: '去购买',
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
            max-height: min(78dvh, 36rem);
            flex-direction: column;
            overflow: auto;
            border-radius: 1.25rem 1.25rem 0 0;
            background: #ffffff;
            color: #18181b;
            padding: 1rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));
            box-shadow: 0 -1rem 3rem rgb(0 0 0 / 18%);
          }
          [data-viceme='header'] {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
          }
          [data-viceme='title'] {
            margin: 0;
            font-size: 1.125rem;
            font-weight: 700;
          }
          [data-viceme='close'] {
            display: grid;
            width: 2.5rem;
            min-height: 2.5rem;
            flex: 0 0 2.5rem;
            place-items: center;
            border: 1px solid #d4d4d8;
            border-radius: 999px;
            padding: 0;
            background: #ffffff;
            color: #18181b;
            font-size: 1.5rem;
            font-weight: 400;
            line-height: 1;
          }
          [data-viceme='close']:hover { border-color: #18181b; background: #f4f4f5; }
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
          [data-viceme='profile-description'] { margin: 0.25rem 0 0; color: #71717a; }
          [data-viceme='actions'] {
            display: flex;
            justify-content: flex-end;
            gap: 0.75rem;
            margin-top: auto;
            padding-top: 0.5rem;
          }
          [data-viceme='phone-form'] {
            display: none;
            min-height: 0;
            flex: 1;
            flex-direction: column;
            gap: 0.875rem;
            padding-top: 1rem;
          }
          [data-viceme='panel'][data-phone='true'] [data-viceme='description'],
          [data-viceme='panel'][data-phone='true'] [data-viceme='profile'],
          [data-viceme='panel'][data-phone='true'] > [data-viceme='content'] > [data-viceme='actions'] { display: none; }
          [data-viceme='panel'][data-phone='true'] [data-viceme='phone-form'] { display: flex; }
          [data-viceme='field'] { display: grid; gap: 0.375rem; }
          [data-viceme='field-label'] { color: #3f3f46; font-size: 0.875rem; font-weight: 600; }
          [data-viceme='input'] {
            box-sizing: border-box;
            width: 100%;
            min-height: 2.75rem;
            border: 1px solid #d4d4d8;
            border-radius: 0.75rem;
            padding: 0.625rem 0.75rem;
            background: #ffffff;
            color: #18181b;
            font: 400 1rem/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          }
          [data-viceme='input']:focus { border-color: #18181b; outline: 2px solid #18181b; outline-offset: 2px; }
          [data-viceme='code-row'] { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.625rem; }
          [data-viceme='send-code'] { min-width: 7.5rem; border: 1px solid #18181b; background: #ffffff; color: #18181b; }
          [data-viceme='phone-hint'] { margin: 0; color: #71717a; font-size: 0.75rem; }
          button {
            min-height: 2.75rem;
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
          button:disabled { cursor: wait; opacity: 0.5; }
          button[hidden] { display: none; }
          [data-viceme='error'] { min-height: 1.25rem; margin: 0 0 0.75rem; color: #b91c1c; font-size: 0.875rem; }
          [data-viceme='frame'] {
            display: none;
            width: 100%;
            height: min(72dvh, 42rem);
            border: 0;
            border-radius: 0.75rem;
            background: #ffffff;
          }
          [data-viceme='panel'][data-frame='true'] { max-height: 92dvh; }
          [data-viceme='panel'][data-frame='true'] [data-viceme='content'] { display: none; }
          [data-viceme='panel'][data-frame='true'] [data-viceme='frame'] { display: block; margin-top: 0.75rem; }
          [data-viceme='panel'][data-action='SIGN_IN'][data-frame='true'] [data-viceme='frame'] {
            height: min(62dvh, 31rem);
          }
          @media (min-width: 48rem) {
            :host { place-items: center; padding: 1.5rem; }
            [data-viceme='panel'] {
              width: min(28rem, 100%);
              min-height: 22rem;
              border-radius: 1.25rem;
              padding: 1.25rem;
              box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 24%);
            }
            [data-viceme='panel'][data-frame='true'] { width: min(52rem, 100%); }
            [data-viceme='panel'][data-action='SIGN_IN'][data-frame='true'] { width: min(30rem, 100%); }
          }
          @media (prefers-reduced-motion: no-preference) {
            [data-viceme='panel'] { animation: viceme-enter 160ms ease-out; }
            @keyframes viceme-enter { from { opacity: 0; transform: translateY(1rem); } }
          }
        </style>
        <button data-viceme="backdrop" type="button" tabindex="-1" aria-label="关闭"></button>
        <section data-viceme="panel" role="dialog" aria-modal="true" aria-labelledby="viceme-layer-title">
          <div data-viceme="header">
            <h2 data-viceme="title" id="viceme-layer-title"></h2>
            <button data-viceme="close" type="button" aria-label="关闭">&times;</button>
          </div>
          <div data-viceme="content">
            <p data-viceme="description"></p>
            <section data-viceme="profile" aria-label="关注对象">
              <img data-viceme="avatar" hidden />
              <span data-viceme="avatar-fallback" aria-hidden="true"></span>
              <p data-viceme="profile-name"></p>
              <p data-viceme="profile-description"></p>
            </section>
            <p data-viceme="error" role="alert" aria-live="polite"></p>
            <div data-viceme="actions">
              <button data-viceme="secondary-action" data-viceme-phone-action type="button">手机号登录</button>
              <button data-viceme="action" type="button"></button>
            </div>
            <form data-viceme="phone-form">
              <label data-viceme="field">
                <span data-viceme="field-label">手机号</span>
                <input data-viceme="input" data-viceme-phone type="tel" inputmode="numeric" autocomplete="tel" maxlength="11" placeholder="请输入中国大陆手机号" />
              </label>
              <label data-viceme="field">
                <span data-viceme="field-label">验证码</span>
                <span data-viceme="code-row">
                  <input data-viceme="input" data-viceme-code type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码" />
                  <button data-viceme="send-code" type="button">获取验证码</button>
                </span>
              </label>
              <p data-viceme="phone-hint">未注册的手机号验证后将自动创建 ViceMe 账号。</p>
              <div data-viceme="actions">
                <button data-viceme="secondary-action" data-viceme-phone-back type="button">返回</button>
                <button data-viceme="action" data-viceme-phone-submit type="submit">登录</button>
              </div>
            </form>
          </div>
          <iframe data-viceme="frame" title="" referrerpolicy="no-referrer" allow="payment"></iframe>
        </section>
      `;
      const panel = shadow.querySelector<HTMLElement>("[data-viceme='panel']")!;
      panel.dataset.action = this.interaction.action;
      shadow.querySelector<HTMLElement>("[data-viceme='title']")!.textContent = copy.title;
      shadow.querySelector<HTMLElement>("[data-viceme='description']")!.textContent =
        copy.description;
      const action = shadow.querySelector<HTMLButtonElement>("[data-viceme='action']")!;
      const phoneAction = shadow.querySelector<HTMLButtonElement>('[data-viceme-phone-action]')!;
      const backdrop = shadow.querySelector<HTMLButtonElement>("[data-viceme='backdrop']")!;
      const closeButton = shadow.querySelector<HTMLButtonElement>("[data-viceme='close']")!;
      const error = shadow.querySelector<HTMLElement>("[data-viceme='error']")!;
      const frame = shadow.querySelector<HTMLIFrameElement>("[data-viceme='frame']")!;
      const profile = shadow.querySelector<HTMLElement>("[data-viceme='profile']")!;
      const avatar = shadow.querySelector<HTMLImageElement>("[data-viceme='avatar']")!;
      const avatarFallback = shadow.querySelector<HTMLElement>("[data-viceme='avatar-fallback']")!;
      const profileName = shadow.querySelector<HTMLElement>("[data-viceme='profile-name']")!;
      const profileDescription = shadow.querySelector<HTMLElement>(
        "[data-viceme='profile-description']",
      )!;
      const phoneForm = shadow.querySelector<HTMLFormElement>("[data-viceme='phone-form']")!;
      const phoneInput = shadow.querySelector<HTMLInputElement>('[data-viceme-phone]')!;
      const codeInput = shadow.querySelector<HTMLInputElement>('[data-viceme-code]')!;
      const sendCode = shadow.querySelector<HTMLButtonElement>("[data-viceme='send-code']")!;
      const phoneBack = shadow.querySelector<HTMLButtonElement>('[data-viceme-phone-back]')!;
      const phoneSubmit = shadow.querySelector<HTMLButtonElement>('[data-viceme-phone-submit]')!;
      action.textContent = copy.label;
      phoneAction.hidden = !this.interaction.phoneAuth;
      const idleActionLabel = copy.label;
      frame.title = copy.title;

      const target = this.interaction.followTarget;
      if (target) {
        profile.dataset.visible = 'true';
        profileName.textContent = target.displayName;
        profileDescription.textContent =
          target.description ?? (target.kind === 'CREATOR' ? '创作者' : 'ViceMe 用户');
        avatarFallback.textContent = target.displayName.trim().slice(0, 1) || 'V';
        if (target.avatarUrl) {
          avatar.src = target.avatarUrl;
          avatar.alt = `${target.displayName}的头像`;
          avatar.hidden = false;
          avatarFallback.hidden = true;
        }
      }

      let activeFrame: AccessFrameAction | null = null;
      let countdownTimer: number | null = null;
      const clearCountdown = () => {
        if (countdownTimer !== null) window.clearInterval(countdownTimer);
        countdownTimer = null;
      };
      const close = (result: AccessPresentationResult) => {
        clearCountdown();
        this.dispatchEvent(new CustomEvent('viceme:access-layer-close', { detail: result }));
      };
      const dismissLayer = () => {
        activeFrame?.cancel();
        close('dismissed');
      };
      backdrop.addEventListener('click', dismissLayer);
      closeButton.addEventListener('click', dismissLayer);
      this.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') dismissLayer();
        if (event.key === 'Tab') {
          event.preventDefault();
          if (activeFrame) {
            closeButton.focus();
            return;
          }
          const focusable =
            panel.dataset.phone === 'true'
              ? [closeButton, phoneInput, codeInput, sendCode, phoneBack, phoneSubmit]
              : [closeButton, ...(phoneAction.hidden ? [] : [phoneAction]), action];
          const available = focusable.filter((element) => !element.disabled);
          const currentIndex = available.indexOf(
            shadow.activeElement as HTMLButtonElement | HTMLInputElement,
          );
          const direction = event.shiftKey ? -1 : 1;
          available[(currentIndex + direction + available.length) % available.length]?.focus();
        }
      });
      phoneInput.addEventListener('input', () => {
        phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 11);
      });
      codeInput.addEventListener('input', () => {
        codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
      });
      phoneAction.addEventListener('click', () => {
        panel.dataset.phone = 'true';
        shadow.querySelector<HTMLElement>("[data-viceme='title']")!.textContent = '手机号登录';
        error.textContent = '';
        phoneInput.focus();
      });
      phoneBack.addEventListener('click', () => {
        panel.dataset.phone = 'false';
        shadow.querySelector<HTMLElement>("[data-viceme='title']")!.textContent = copy.title;
        error.textContent = '';
        phoneAction.focus();
      });
      sendCode.addEventListener('click', async () => {
        const phone = phoneInput.value;
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          error.textContent = '请输入正确的中国大陆手机号。';
          phoneInput.focus();
          return;
        }
        sendCode.disabled = true;
        sendCode.textContent = '发送中…';
        error.textContent = '';
        try {
          const result = await this.interaction.phoneAuth!.sendCode(phone);
          let remaining = result.retryAfterSeconds;
          sendCode.textContent = `${remaining} 秒后重试`;
          clearCountdown();
          countdownTimer = window.setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearCountdown();
              sendCode.disabled = false;
              sendCode.textContent = '重新获取';
              return;
            }
            sendCode.textContent = `${remaining} 秒后重试`;
          }, 1_000);
          codeInput.focus();
        } catch {
          sendCode.disabled = false;
          sendCode.textContent = '获取验证码';
          error.textContent = '验证码发送失败，请稍后重试。';
        }
      });
      phoneForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const phone = phoneInput.value;
        const code = codeInput.value;
        if (!/^1[3-9]\d{9}$/.test(phone) || !/^\d{6}$/.test(code)) {
          error.textContent = '请输入正确的手机号和 6 位验证码。';
          return;
        }
        phoneSubmit.disabled = true;
        phoneSubmit.textContent = '登录中…';
        error.textContent = '';
        try {
          await this.interaction.phoneAuth!.signIn(phone, code);
          close('acted');
        } catch {
          phoneSubmit.disabled = false;
          phoneSubmit.textContent = '登录';
          error.textContent = '手机号或验证码不正确，请重试。';
        }
      });
      action.addEventListener('click', async () => {
        action.disabled = true;
        action.setAttribute('aria-busy', 'true');
        action.textContent = '正在打开…';
        error.textContent = '';
        try {
          const result = await this.interaction.perform();
          if (result.type === 'frame') {
            activeFrame = result;
            panel.dataset.frame = 'true';
            frame.src = result.url;
            closeButton.focus();
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
          action.removeAttribute('aria-busy');
          action.textContent = idleActionLabel;
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
