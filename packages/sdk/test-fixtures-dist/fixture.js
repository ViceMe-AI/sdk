function createFixtureCapability(client) {
  return {
    name: "fixture",
    ping() {
      return { workKey: client.workKey, ready: client.state === "READY" };
    }
  };
}
function createFixtureLifecycle() {
  const listeners = /* @__PURE__ */ new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of listeners) listener();
    },
    get listenerCount() {
      return listeners.size;
    }
  };
}
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
async function mount(client, options) {
  const capability = createFixtureCapability(client);
  const lifecycle = createFixtureLifecycle();
  const host = options.target;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = STYLE;
  const root = document.createElement("div");
  root.className = "viceme-fixture";
  root.dataset.theme = options.theme === "auto" ? "light" : options.theme;
  root.textContent = `ViceMe fixture · ${capability.ping().workKey}`;
  shadow.append(style, root);
  const observer = new ResizeObserver(() => lifecycle.emit());
  observer.observe(root);
  return {
    capability: "fixture",
    destroy() {
      observer.disconnect();
      shadow.innerHTML = "";
    }
  };
}
export {
  createFixtureCapability,
  mount
};
//# sourceMappingURL=fixture.js.map
