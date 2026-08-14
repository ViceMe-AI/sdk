/**
 * Shared pointer read/poll helpers for the stable-alias writers.
 */

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** fetch with a per-request timeout of at most `budgetMs`. */
function fetchBudgeted(url, budgetMs) {
  const ms = Math.max(200, Math.min(budgetMs, 5_000));
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined;
  return fetch(url, { credentials: 'omit', headers: { 'cache-control': 'no-cache' }, signal });
}

/** Poll until the body EXACTLY equals `expected` (bounded, per-request timeout). */
export async function awaitBodyEquals(url, expected, timeoutMs, pollIntervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '(no response)';
  while (Date.now() < deadline) {
    try {
      const response = await fetchBudgeted(url, deadline - Date.now());
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const { createHash } = await import('node:crypto');
        last = `${buffer.length}B (sha256 ${createHash('sha256').update(buffer).digest('hex').slice(0, 12)}…)`;
        if (buffer.equals(expected)) return;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = `fetch error: ${String(error)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  console.error(`body did not match within ${timeoutMs}ms: ${url}`);
  console.error(`  last seen: ${last}`);
  process.exit(1);
}

/**
 * Strict single read of a pointer URL.
 *
 * Returns:
 *   { kind: 'value', value }  — pointer is set to a valid version string;
 *   { kind: 'unset' }         — the origin answered 404 (genuinely absent);
 *   { kind: 'error', detail } — 403/5xx/timeouts/garbage bodies. Callers
 *                               MUST fail closed: treating these as "unset"
 *                               would let a stale run overwrite a newer
 *                               live pointer during a transient read fault.
 */
export async function readPointerState(url) {
  let response;
  try {
    response = await fetchBudgeted(url, 5_000);
  } catch (error) {
    return { kind: 'error', detail: `fetch failed: ${String(error)}` };
  }
  if (response.status === 404) return { kind: 'unset' };
  if (!response.ok) {
    return { kind: 'error', detail: `HTTP ${response.status}` };
  }
  const text = (await response.text()).trim();
  if (!SEMVER.test(text)) {
    return { kind: 'error', detail: `unparseable pointer body '${text.slice(0, 40)}'` };
  }
  return { kind: 'value', value: text };
}

/** Back-compat helper for callers that already fail closed upstream. */
export async function readPointerValue(url) {
  const state = await readPointerState(url);
  return state.kind === 'value' ? state.value : undefined;
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
      const response = await fetchBudgeted(url, deadline - Date.now());
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
