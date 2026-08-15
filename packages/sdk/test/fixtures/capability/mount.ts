/**
 * Fixture capability — Shadow DOM mount.
 *
 * Proves the §9.1 isolation contract: the component lives in an open Shadow
 * Root, writes no global CSS, and exposes theming through documented custom
 * properties. `destroy()` removes the subtree and disconnects observers.
 */

import type { ViceMeClient } from '../../../src/core/client.ts';
import type {
  CapabilityMountHandle,
  CapabilityMountOptions,
} from '../../../src/loader/mount-handle.ts';
import { createFixtureCapability } from './client.ts';
import { createFixtureLifecycle } from './lifecycle.ts';

const STYLE = `
  :host { display: block; font: 14px/1.4 system-ui, sans-serif; color: var(--viceme-fg, #1f2937); }
  .viceme-fixture {
    padding: 8px 12px; border-radius: 8px;
    background: var(--viceme-bg, #f3f4f6);
    border: 1px solid var(--viceme-border, #d1d5db);
  }
  .viceme-fixture[data-theme="dark"] {
    --viceme-bg: #111827; --viceme-border: #374151; --viceme-fg: #f9fafb;
  }
`;

export async function mount(
  client: ViceMeClient,
  options: CapabilityMountOptions,
): Promise<CapabilityMountHandle> {
  const capability = createFixtureCapability(client);
  const lifecycle = createFixtureLifecycle();
  const host = options.target;

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = STYLE;
  const root = document.createElement('div');
  root.className = 'viceme-fixture';
  root.dataset.theme = options.theme === 'auto' ? 'light' : options.theme;
  root.textContent = `ViceMe fixture · ${capability.ping().workKey}`;
  shadow.append(style, root);

  // Demonstrate resource ownership that must be cleaned up on destroy.
  const observer = new ResizeObserver(() => lifecycle.emit());
  observer.observe(root);

  return {
    capability: 'fixture',
    destroy(): void {
      observer.disconnect();
      shadow.innerHTML = '';
    },
  };
}
