/**
 * IIFE entry for the CDN auto-loader.
 *
 * Side-effect only: imports the loader (which bootstraps from
 * `document.currentScript`) and exports nothing, so the built
 * `viceme.min.js` never leaves a global binding behind — the fixed
 * `window.ViceMe.versions.v1` namespace is installed non-enumerably by the
 * loader itself.
 */
import './auto-loader.ts';
