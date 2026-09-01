/**
 * `data-viceme-*` attribute parsing for the CDN auto-loader.
 *
 * The attribute set is fixed; unknown `data-viceme-*` attributes are rejected
 * so pages can never smuggle endpoints, tokens, secrets, prices, or payment
 * state through the loader. Parse failures never guess defaults for work,
 * region, or target.
 */

import { configInvalid } from '../core/errors.ts';
import type { ViceMeRegion } from '../core/config.ts';
import { isValidRegion, isValidWorkKey } from '../core/config.ts';

export type ViceMeTheme = 'light' | 'dark' | 'auto';
export type LoaderFeature = 'danmaku' | 'tip';

export interface LoaderAttributes {
  workKey: string;
  region: ViceMeRegion;
  /** Hosted capabilities mounted by this loader invocation. */
  features: LoaderFeature[];
  /** CSS selector; required whenever features are declared. */
  target?: string;
  theme: ViceMeTheme;
}

const KNOWN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'data-viceme-work',
  'data-viceme-region',
  'data-viceme-features',
  'data-viceme-target',
  'data-viceme-theme',
  // Marker for explicit opt-in when document.currentScript is unavailable.
  'data-viceme-loader',
]);

const THEMES: ReadonlySet<string> = new Set(['light', 'dark', 'auto']);
const FEATURE_ORDER: readonly LoaderFeature[] = ['danmaku', 'tip'];

export function parseLoaderAttributes(element: Element): LoaderAttributes {
  for (const name of element.getAttributeNames()) {
    if (name.startsWith('data-viceme-') && !KNOWN_ATTRIBUTES.has(name)) {
      throw configInvalid(`Unknown loader attribute "${name}".`);
    }
  }

  const workKey = element.getAttribute('data-viceme-work');
  if (!isValidWorkKey(workKey)) {
    throw configInvalid('Loader attribute "data-viceme-work" must be a public Work key.');
  }

  const region = element.getAttribute('data-viceme-region');
  if (!isValidRegion(region)) {
    throw configInvalid('Loader attribute "data-viceme-region" must be "cn" or "global".');
  }

  const rawFeatures = element.getAttribute('data-viceme-features');
  const declaredFeatures = rawFeatures?.split(',') ?? [];
  const featureSet = new Set(declaredFeatures);
  if (
    !rawFeatures ||
    /\s/.test(rawFeatures) ||
    declaredFeatures.length !== featureSet.size ||
    declaredFeatures.some(
      (feature): feature is string => !FEATURE_ORDER.includes(feature as LoaderFeature),
    )
  ) {
    throw configInvalid(
      'Loader attribute "data-viceme-features" must contain each of "danmaku" and "tip" at most once.',
    );
  }
  const features = FEATURE_ORDER.filter((feature) => featureSet.has(feature));

  const target = element.getAttribute('data-viceme-target');
  if (target === '') {
    throw configInvalid('Loader attribute "data-viceme-target" must be a CSS selector.');
  }
  // Loader-mounted features are visual capabilities, so a target is required.
  if (target === null) {
    throw configInvalid(
      'Loader attribute "data-viceme-target" is required when features are declared.',
    );
  }
  try {
    // Probe-parse the selector now: an invalid selector is a configuration
    // error and must fail closed here, never surface later as a retryable
    // INTERNAL_ERROR from querySelectorAll.
    element.matches(target);
  } catch {
    throw configInvalid('Loader attribute "data-viceme-target" is not a valid CSS selector.');
  }

  const rawTheme = element.getAttribute('data-viceme-theme');
  if (rawTheme !== null && !THEMES.has(rawTheme)) {
    throw configInvalid('Loader attribute "data-viceme-theme" must be "light", "dark", or "auto".');
  }

  return {
    workKey,
    region,
    features,
    target,
    theme: (rawTheme ?? 'auto') as ViceMeTheme,
  };
}
