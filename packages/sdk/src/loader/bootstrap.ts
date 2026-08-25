/**
 * FIXED alias bootstrap — the ONLY object under /viceme-sdk/v1/.
 *
 * Byte-stable for the whole API major (this file must not grow feature
 * logic): it reads the version pointer at /viceme-sdk/-/aliases/v1 and
 * injects the full versioned auto-loader at
 * /viceme-sdk/<version>/viceme.min.js with the same data-viceme-*
 * attributes. The full loader (and every future fix to it) lives in the
 * immutable exact-version directory, so the alias bytes never need to
 * change when releases ship.
 */
(() => {
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement) || !script.src) return;

  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(8_000)
      : undefined;

  fetch(new URL('/viceme-sdk/-/aliases/v1', script.src), {
    credentials: 'omit',
    signal,
  })
    .then((response) => {
      if (!response.ok) throw new Error(`pointer HTTP ${response.status}`);
      return response.text();
    })
    .then((text) => {
      const version = text.trim();
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error('invalid pointer');
      }
      const loader = document.createElement('script');
      for (const name of script.getAttributeNames()) {
        // The loader gets its own src; integrity pins are not transferable.
        if (name === 'src' || name === 'integrity' || name === 'nonce') continue;
        loader.setAttribute(name, script.getAttribute(name) ?? '');
      }
      loader.nonce = script.nonce;
      loader.src = new URL(`/viceme-sdk/${version}/viceme.min.js`, script.src).href;
      (document.head ?? document.documentElement).append(loader);
    })
    .catch(() => {
      document.dispatchEvent(
        new CustomEvent('viceme:error', {
          detail: { code: 'CONFIG_INVALID', retryable: false },
          bubbles: true,
          composed: true,
        }),
      );
    });
})();
