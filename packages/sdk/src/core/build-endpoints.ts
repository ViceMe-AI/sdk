declare const __VICEME_BUILD_CN_API_BASE_URL__: string | undefined;
declare const __VICEME_BUILD_GLOBAL_API_BASE_URL__: string | undefined;
declare const __VICEME_BUILD_CN_WIDGET_ORIGIN__: string | undefined;
declare const __VICEME_BUILD_GLOBAL_WIDGET_ORIGIN__: string | undefined;

export const BUILD_API_BASE_URLS = {
  cn:
    typeof __VICEME_BUILD_CN_API_BASE_URL__ === 'string'
      ? __VICEME_BUILD_CN_API_BASE_URL__
      : 'https://api.viceme.cn',
  global:
    typeof __VICEME_BUILD_GLOBAL_API_BASE_URL__ === 'string'
      ? __VICEME_BUILD_GLOBAL_API_BASE_URL__
      : 'https://api.viceme.ai/v1',
} as const;

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
