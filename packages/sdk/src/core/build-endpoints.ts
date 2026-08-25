declare const __VICEME_BUILD_CN_WIDGET_ORIGIN__: string | undefined;
declare const __VICEME_BUILD_GLOBAL_WIDGET_ORIGIN__: string | undefined;

/** Hosted Shop origins baked into immutable release artifacts. */
export const BUILD_WIDGET_ORIGINS = {
  cn:
    typeof __VICEME_BUILD_CN_WIDGET_ORIGIN__ === 'string'
      ? __VICEME_BUILD_CN_WIDGET_ORIGIN__
      : 'https://viceme.cn',
  global:
    typeof __VICEME_BUILD_GLOBAL_WIDGET_ORIGIN__ === 'string'
      ? __VICEME_BUILD_GLOBAL_WIDGET_ORIGIN__
      : 'https://viceme.ai',
} as const;
