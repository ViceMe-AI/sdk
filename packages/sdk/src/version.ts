/**
 * Single source of truth for the SDK runtime version.
 *
 * Kept in sync with `packages/sdk/package.json#version`; a unit test enforces
 * the match so the loader, release manifest, and npm metadata can never drift.
 */
export const SDK_VERSION = '0.1.0';

/** Public API major carried by this build (loader namespace `v1`). */
export const API_MAJOR = 1;
