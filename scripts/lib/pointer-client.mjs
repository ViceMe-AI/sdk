/**
 * Shared pointer read/poll helpers for the stable-alias writers.
 */

/** Best-effort single read of a pointer URL (undefined when unset/absent). */
export async function readPointerValue(url) {
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      headers: { 'cache-control': 'no-cache' },
    });
    if (!response.ok) return undefined;
    const text = (await response.text()).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Poll a pointer URL until it equals `expected`, within a bounded budget.
 * On timeout, print the last observed value (stale edge vs origin problem)
 * and exit(1).
 */
export async function awaitPointerConvergence(url, expected, timeoutMs, pollIntervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let lastObserved = '(no response)';
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        headers: { 'cache-control': 'no-cache' },
      });
      lastStatus = response.status;
      if (response.ok) {
        lastObserved = (await response.text()).trim();
        if (lastObserved === expected) return;
      }
    } catch (error) {
      lastObserved = `(fetch error: ${String(error)})`;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  console.error(`pointer did not converge within ${timeoutMs}ms: ${url}`);
  console.error(`  expected:   '${expected}'`);
  console.error(`  last seen:  '${lastObserved}' (HTTP ${lastStatus})`);
  process.exit(1);
}
