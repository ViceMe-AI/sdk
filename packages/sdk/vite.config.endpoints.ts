function buildUrl(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  const parsed = new URL(value);
  const isLoopback =
    parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error(`${name} must use HTTPS unless it targets loopback.`);
  }
  return value.replace(/\/$/, '');
}

export function buildEndpointDefinitions(): Record<string, string> {
  return {
    __VICEME_BUILD_CN_API_BASE_URL__: JSON.stringify(
      buildUrl('VICEME_BUILD_CN_API_BASE_URL', 'https://api.viceme.cn'),
    ),
    __VICEME_BUILD_GLOBAL_API_BASE_URL__: JSON.stringify(
      buildUrl('VICEME_BUILD_GLOBAL_API_BASE_URL', 'https://api.viceme.ai/v1'),
    ),
    __VICEME_BUILD_CN_WIDGET_ORIGIN__: JSON.stringify(
      buildUrl('VICEME_BUILD_CN_WIDGET_ORIGIN', 'https://viceme.cn'),
    ),
    __VICEME_BUILD_GLOBAL_WIDGET_ORIGIN__: JSON.stringify(
      buildUrl('VICEME_BUILD_GLOBAL_WIDGET_ORIGIN', 'https://viceme.ai'),
    ),
  };
}
