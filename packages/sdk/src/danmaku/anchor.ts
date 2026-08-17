export interface DanmakuPageAnchor {
  /** Stable page-and-position key sent to the hosted danmaku runtime. */
  anchorKey: string;
  /** Human-readable 10% scroll bucket, useful for diagnostics. */
  scrollBucket: string;
}

/**
 * Build a stable page-position anchor without exposing the page URL.
 *
 * Canonical URLs and SPA hash routes participate in the local hash. Only the
 * resulting opaque key leaves the host page.
 */
export function readDanmakuPageAnchor(
  windowObject: Window = window,
  documentObject: Document = document,
): DanmakuPageAnchor {
  const pageUrl = canonicalPageUrl(windowObject, documentObject);
  const bucket = scrollBucket(windowObject, documentObject);
  return {
    anchorKey: `page:${hashString(pageUrl)}:scroll:${bucket}`,
    scrollBucket: bucket,
  };
}

function canonicalPageUrl(windowObject: Window, documentObject: Document): string {
  const canonical = documentObject.querySelector<HTMLLinkElement>('link[rel="canonical"][href]');
  const rawUrl = canonical?.href || windowObject.location.href;
  try {
    const url = new URL(rawUrl, windowObject.location.href);
    url.username = '';
    url.password = '';
    if (canonical && !url.hash && windowObject.location.hash) {
      url.hash = windowObject.location.hash;
    }
    return url.toString();
  } catch {
    return windowObject.location.href;
  }
}

function scrollBucket(windowObject: Window, documentObject: Document): string {
  const root = documentObject.documentElement;
  const body = documentObject.body;
  const scrollTop =
    windowObject.scrollY || windowObject.pageYOffset || root.scrollTop || body?.scrollTop || 0;
  const scrollHeight = Math.max(
    root.scrollHeight,
    root.offsetHeight,
    root.clientHeight,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
  );
  const maxScroll = Math.max(0, scrollHeight - windowObject.innerHeight);
  if (maxScroll <= 1) return '0-100';

  const percent = Math.max(0, Math.min(99, (scrollTop / maxScroll) * 100));
  const start = Math.min(90, Math.floor(percent / 10) * 10);
  return `${start}-${start + 10}`;
}

/** Deterministic 64-bit-style hash encoded as at most 16 base36 characters. */
function hashString(value: string): string {
  let high = 0xdeadbeef ^ value.length;
  let low = 0x41c6ce57 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    high = Math.imul(high ^ character, 2654435761);
    low = Math.imul(low ^ character, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507);
  high ^= Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507);
  low ^= Math.imul(high ^ (high >>> 13), 3266489909);
  return (
    (low >>> 0).toString(36).padStart(7, '0') + (high >>> 0).toString(36).padStart(7, '0')
  ).slice(0, 16);
}
