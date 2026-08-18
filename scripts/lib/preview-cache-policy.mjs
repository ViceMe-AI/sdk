const SHORT_ALIAS_CACHE = 'public,max-age=300';
const IMMUTABLE_VERSION_CACHE = 'public,max-age=31536000,immutable';

export function previewCacheControl(pathname, version) {
  if (pathname.startsWith(`/viceme-sdk/${version}/`)) {
    return IMMUTABLE_VERSION_CACHE;
  }
  if (pathname === '/viceme-sdk/v1/viceme.min.js') {
    return SHORT_ALIAS_CACHE;
  }
  return 'no-store';
}
