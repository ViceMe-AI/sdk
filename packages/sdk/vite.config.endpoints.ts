function buildOrigin(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  const parsed = new URL(value);
  const isLoopback =
    parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error(`${name} must use HTTPS unless it targets loopback.`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment.`);
  }
  return parsed.origin;
}

export function buildEndpointDefinitions(): Record<string, string> {
  return {
    __VICEME_BUILD_CN_WIDGET_ORIGIN__: JSON.stringify(
      buildOrigin('VICEME_BUILD_CN_WIDGET_ORIGIN', 'https://poc.viceme.cn'),
    ),
    __VICEME_BUILD_GLOBAL_WIDGET_ORIGIN__: JSON.stringify(
      buildOrigin('VICEME_BUILD_GLOBAL_WIDGET_ORIGIN', 'https://poc.viceme.cn'),
    ),
  };
}
