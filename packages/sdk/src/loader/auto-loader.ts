/**
 * CDN auto-loader (`viceme.min.js`, IIFE).
 *
 * Deterministic algorithm (fixed baseline):
 *
 * 1. Read `document.currentScript`; when unavailable, accept exactly one
 *    explicit `script[data-viceme-loader]`.
 * 2. Parse and validate `data-viceme-*`; build `clientKey` and per-feature
 *    `instanceKey`s.
 * 3. Wait for DOM ready; a missing/ambiguous target emits `CONFIG_INVALID`
 *    and never creates phantom nodes.
 * 4. Read `manifest.json` from the loader's own directory (exact release
 *    version; URLs are never assembled from page parameters).
 * 5. Load the same-version core, then each declared feature chunk in order.
 * 6. Create the client, then mount; handles land in an internal registry.
 * 7. Re-running the same instance key returns the original handle — no
 *    duplicate sessions, subscriptions, or DOM.
 * 8. A failing capability destroys only its own partial state; the rest of
 *    the page and other capabilities keep working.
 * 9. `pagehide` never auto-destroys (bfcache); cleanup happens on explicit
 *    `destroy()` only.
 *
 * The loader never writes localStorage, cookies, global CSS, or globals other
 * than the fixed `window.ViceMe.versions.vN` namespace.
 */

import { parseLoaderAttributes, type LoaderAttributes } from './attributes.ts';
import { LoaderRegistry, clientKeyOf, type RegisteredInstance } from './registry.ts';
import type { CapabilityMountHandle, CapabilityMountFunction } from './mount-handle.ts';
import { dispatchViceMeEvent, type VicemeErrorDetail } from './events.ts';
import { configInvalid, ViceMeError } from '../core/errors.ts';
import type { ViceMeClient, ViceMeMountedInstance } from '../core/client.ts';
import { API_MAJOR } from '../version.ts';

export interface ReleaseManifest {
  version: string;
  apiMajor: number;
  loader: string;
  features: Record<string, string>;
}

interface CoreModule {
  createViceMe: (config: unknown) => ViceMeClient;
}

/** Internal surface the core implementation provides to the loader. */
interface InternalCoreClient extends ViceMeClient {
  markDegraded(): void;
}

export interface ViceMeLoaderNamespaceV1 {
  readonly version: string;
  whenReady(clientKey: string): Promise<ViceMeClient>;
  getInstance(instanceKey: string): ViceMeMountedInstance | undefined;
  destroyInstance(instanceKey: string): void;
  destroyClient(clientKey: string): void;
}

export interface ViceMeBrowserGlobal {
  versions: {
    // Other majors coexist; they are never overwritten by this loader.
    [major: string]: ViceMeLoaderNamespaceV1 | undefined;
  };
}

const MANIFEST_TIMEOUT_MS = 8_000;

interface LoaderSharedState {
  registry: LoaderRegistry;
  /** Serialized run queue shared across every execution of this loader. */
  queue: { current: Promise<void> };
}

const STATE_KEY = Symbol.for('viceme.loader.state.v1');

/**
 * Loader state must survive multiple executions of the same (or an identical)
 * loader `<script>`: browsers execute each script tag as an independent IIFE,
 * so the registry and run queue live on a hidden, symbol-keyed, non-enumerable
 * global — never an undeclared string-named global.
 */
function sharedState(): LoaderSharedState {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[STATE_KEY] as LoaderSharedState | undefined;
  if (existing) return existing;
  const state: LoaderSharedState = {
    registry: new LoaderRegistry(),
    queue: { current: Promise.resolve() },
  };
  Object.defineProperty(globalThis, STATE_KEY, {
    value: state,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return state;
}

/* ------------------------------------------------------------------ */
/* Instance wrapper + destroy                                          */
/* ------------------------------------------------------------------ */

function destroyInstanceInternal(instance: RegisteredInstance): void {
  if (instance.destroyed) return;
  instance.destroyed = true;
  sharedState().registry.removeInstance(instance.instanceKey);
  try {
    instance.raw.destroy();
  } finally {
    dispatchViceMeEvent(instance.host, 'viceme:destroyed', {
      clientKey: instance.clientKey,
      instanceKey: instance.instanceKey,
      capability: instance.capability,
    });
  }
}

function wrapInstance(instance: RegisteredInstance): ViceMeMountedInstance {
  return {
    instanceKey: instance.instanceKey,
    capability: instance.capability,
    destroy: () => destroyInstanceInternal(instance),
  };
}

/* ------------------------------------------------------------------ */
/* Namespace installation                                              */
/* ------------------------------------------------------------------ */

function defineHidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function ensureNamespace(version: string): ViceMeLoaderNamespaceV1 {
  const holder = globalThis as { ViceMe?: ViceMeBrowserGlobal };
  let global = holder.ViceMe;
  if (!global) {
    global = {} as ViceMeBrowserGlobal;
    defineHidden(globalThis, 'ViceMe', global);
  }
  let versions = global.versions;
  if (!versions) {
    versions = {} as ViceMeBrowserGlobal['versions'];
    defineHidden(global, 'versions', versions);
  }
  const existing = versions[`v${API_MAJOR}`];
  if (existing) return existing;

  const namespace: ViceMeLoaderNamespaceV1 = {
    version,
    whenReady(clientKey: string): Promise<ViceMeClient> {
      const entry = sharedState().registry.getClient(clientKey);
      if (!entry) {
        return Promise.reject(configInvalid(`Unknown clientKey "${clientKey}".`));
      }
      return entry.ready.then(() => entry.client);
    },
    getInstance(instanceKey: string): ViceMeMountedInstance | undefined {
      const instance = sharedState().registry.getInstance(instanceKey);
      return instance ? wrapInstance(instance) : undefined;
    },
    destroyInstance(instanceKey: string): void {
      const instance = sharedState().registry.getInstance(instanceKey);
      if (instance) destroyInstanceInternal(instance);
    },
    destroyClient(clientKey: string): void {
      for (const instance of sharedState().registry.instancesForClient(clientKey)) {
        destroyInstanceInternal(instance);
      }
      const entry = sharedState().registry.getClient(clientKey);
      sharedState().registry.unregisterClient(clientKey);
      entry?.client.destroy();
    },
  };
  defineHidden(versions, `v${API_MAJOR}`, namespace);
  return namespace;
}

/* ------------------------------------------------------------------ */
/* Loader algorithm                                                    */
/* ------------------------------------------------------------------ */

function whenDomReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

async function fetchReleaseManifest(
  manifestUrl: URL,
): Promise<{ manifest: ReleaseManifest; baseUrl: URL }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(manifestUrl);
  } catch {
    response = { ok: false, status: 0 } as Response;
  }
  // Alias path (e.g. /viceme-sdk/v1/) holds no manifest on the S3 topology: it
  // carries only the loader object plus the version POINTER. Resolve the
  // pointer and load the exact version beside it.
  if (!response.ok) {
    const aliasVersion = await resolveAliasPointer(manifestUrl);
    if (aliasVersion !== undefined) {
      const aliasUrl = new URL(`/viceme-sdk/${aliasVersion}/manifest.json`, manifestUrl);
      return { manifest: await parseManifest(await fetchWithTimeout(aliasUrl)), baseUrl: aliasUrl };
    }
  }
  return { manifest: await parseManifest(response), baseUrl: manifestUrl };
}

function fetchWithTimeout(url: URL): Promise<Response> {
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(MANIFEST_TIMEOUT_MS)
      : undefined;
  return fetch(url, { credentials: 'omit', signal });
}

/** Read /viceme-sdk/-/aliases/v1 when the loader sits under /viceme-sdk/v1/. */
async function resolveAliasPointer(manifestUrl: URL): Promise<string | undefined> {
  if (!/\/viceme-sdk\/[^/]+\/manifest\.json$/.test(manifestUrl.pathname)) return undefined;
  const segment = manifestUrl.pathname.split('/viceme-sdk/')[1]?.split('/')[0];
  if (segment !== `v${API_MAJOR}`) return undefined;
  try {
    const response = await fetchWithTimeout(new URL('/viceme-sdk/-/aliases/v1', manifestUrl));
    if (!response.ok) return undefined;
    const version = (await response.text()).trim();
    return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

async function parseManifest(response: Response): Promise<ReleaseManifest> {
  if (!response.ok) {
    throw configInvalid(`Release manifest is not available (HTTP ${response.status}).`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as ReleaseManifest).version !== 'string' ||
    typeof (body as ReleaseManifest).apiMajor !== 'number' ||
    typeof (body as ReleaseManifest).features !== 'object' ||
    (body as ReleaseManifest).features === null
  ) {
    throw configInvalid('Release manifest is malformed.');
  }
  const manifest = body as ReleaseManifest;
  if (manifest.apiMajor !== API_MAJOR) {
    throw configInvalid('Release manifest major version does not match this loader.');
  }
  return manifest;
}

async function loadCore(baseUrl: URL): Promise<CoreModule> {
  const coreUrl = new URL('index.js', baseUrl);
  const core = (await import(/* @vite-ignore */ coreUrl.href)) as Partial<CoreModule>;
  if (typeof core.createViceMe !== 'function') {
    throw configInvalid('SDK core chunk does not export createViceMe().');
  }
  return core as CoreModule;
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'CONFIG_INVALID',
  'WORK_NOT_FOUND',
  'CAPABILITY_DISABLED',
  'CLIENT_DESTROYED',
  'SESSION_EXPIRED',
  'RATE_LIMITED',
  'NETWORK_TIMEOUT',
  'CHECKOUT_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

/**
 * Normalize any thrown value into an event detail. Uses structural checks,
 * not `instanceof`: the loader IIFE and the core ESM chunk are separate
 * builds, so their `ViceMeError` classes are distinct at runtime.
 */
function toErrorDetail(error: unknown): VicemeErrorDetail {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (
      typeof candidate.code === 'string' &&
      KNOWN_ERROR_CODES.has(candidate.code) &&
      typeof candidate.retryable === 'boolean'
    ) {
      const detail: VicemeErrorDetail = {
        code: candidate.code as VicemeErrorDetail['code'],
        retryable: candidate.retryable,
      };
      if (typeof candidate.requestId === 'string') detail.requestId = candidate.requestId;
      if (typeof candidate.capability === 'string') detail.capability = candidate.capability;
      return detail;
    }
  }
  return { code: 'INTERNAL_ERROR', retryable: true };
}

function emitError(
  target: EventTarget,
  error: unknown,
  extra: Partial<Pick<VicemeErrorDetail, 'clientKey' | 'instanceKey' | 'capability'>> = {},
): void {
  dispatchViceMeEvent(target, 'viceme:error', { ...toErrorDetail(error), ...extra });
}

export async function runAutoLoader(script: HTMLScriptElement): Promise<void> {
  let attributes: LoaderAttributes;
  try {
    attributes = parseLoaderAttributes(script);
  } catch (error) {
    // Configuration errors before any host exists go to `document`.
    emitError(document, error);
    return;
  }

  if (!script.src) {
    emitError(document, configInvalid('Loader script requires a src URL.'));
    return;
  }
  const manifestUrl = new URL('manifest.json', script.src);

  let manifest: ReleaseManifest;
  let releaseBase: URL;
  try {
    ({ manifest, baseUrl: releaseBase } = await fetchReleaseManifest(manifestUrl));
  } catch (error) {
    emitError(document, error, {
      clientKey: clientKeyOf(API_MAJOR, attributes.region, attributes.workKey),
    });
    return;
  }

  await whenDomReady();

  let host: Element;
  try {
    const matches = document.querySelectorAll(attributes.target!);
    if (matches.length === 0) {
      throw configInvalid(
        `Loader target "${attributes.target}" matched no element; no node was created.`,
      );
    }
    if (matches.length > 1) {
      throw configInvalid(
        `Loader target "${attributes.target}" matched ${matches.length} elements; exactly one is required.`,
      );
    }
    host = matches[0]!;
  } catch (error) {
    emitError(document, error, {
      clientKey: clientKeyOf(manifest.apiMajor, attributes.region, attributes.workKey),
    });
    return;
  }

  const clientKey = clientKeyOf(manifest.apiMajor, attributes.region, attributes.workKey);
  ensureNamespace(manifest.version);

  // Shared core client per (major, region, workKey).
  let entry = sharedState().registry.getClient(clientKey);
  let client: ViceMeClient;
  if (entry) {
    client = entry.client;
  } else {
    let core: CoreModule;
    try {
      core = await loadCore(releaseBase);
    } catch (error) {
      emitError(host, error, { clientKey });
      return;
    }
    client = core.createViceMe({
      workKey: attributes.workKey,
      region: attributes.region,
    });
    const ready = client.ready();
    // Keep an unhandled-rejection-free copy on the registry entry; failures
    // are reported through this loader run and via whenReady().
    void ready.catch(() => {});
    entry = { clientKey, client, ready };
    sharedState().registry.registerClient(entry);
  }

  try {
    await entry.ready;
  } catch (error) {
    sharedState().registry.unregisterClient(clientKey);
    client.destroy();
    emitError(host, error, { clientKey });
    return;
  }

  let mountedAny = false;
  const mounted: string[] = [];
  for (const capability of attributes.features) {
    // Same client + capability + element: reuse the original handle.
    if (sharedState().registry.findInstance(clientKey, capability, host)) continue;

    const fileName = manifest.features[capability];
    if (typeof fileName !== 'string') {
      (client as InternalCoreClient).markDegraded();
      emitError(
        host,
        new ViceMeError({
          code: 'CAPABILITY_DISABLED',
          message: `Capability "${capability}" is not part of this release.`,
          retryable: false,
          capability,
        }),
        { clientKey, capability },
      );
      continue;
    }

    try {
      const chunkUrl = new URL(fileName, releaseBase);
      const module = (await import(/* @vite-ignore */ chunkUrl.href)) as {
        mount?: unknown;
      };
      if (typeof module.mount !== 'function') {
        throw configInvalid(`Capability chunk "${capability}" does not export mount().`);
      }
      const raw = (await (module.mount as CapabilityMountFunction)(client, {
        target: host,
        theme: attributes.theme,
      })) as CapabilityMountHandle;
      const instance = sharedState().registry.registerInstance(clientKey, capability, host, raw);
      mountedAny = true;
      mounted.push(capability);
      dispatchViceMeEvent(host, 'viceme:capability-ready', {
        clientKey,
        instanceKey: instance.instanceKey,
        capability,
        version: manifest.version,
      });
    } catch (error) {
      // Only this capability's partial state is discarded; everything else
      // (including the host page) keeps working.
      (client as InternalCoreClient).markDegraded();
      emitError(host, error, { clientKey, capability });
    }
  }

  if (mountedAny) {
    dispatchViceMeEvent(host, 'viceme:ready', {
      clientKey,
      workKey: attributes.workKey,
      capabilities: mounted,
      version: manifest.version,
    });
  }
}

/* ------------------------------------------------------------------ */
/* IIFE bootstrap                                                      */
/* ------------------------------------------------------------------ */

/**
 * Loader runs are serialized so identical scripts (duplicate tags, re-runs,
 * same work with different targets) observe registry state deterministically
 * and never create duplicate sessions or DOM.
 */
function enqueueRun(script: HTMLScriptElement): Promise<void> {
  const { queue } = sharedState();
  const run = queue.current.then(() => runAutoLoader(script));
  queue.current = run.catch(() => {});
  return run;
}

function bootstrap(): void {
  if (typeof document === 'undefined') return;
  let script: HTMLScriptElement | null =
    document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;
  if (!script) {
    const explicit = document.querySelectorAll<HTMLScriptElement>('script[data-viceme-loader]');
    if (explicit.length === 1) script = explicit[0] ?? null;
  }
  if (!script) return;
  void enqueueRun(script).catch((error: unknown) => {
    emitError(document, error);
  });
}

bootstrap();

// Test-only handle for re-running the bootstrap in controlled environments.
export const __bootstrapForTests = bootstrap;
export type { RegisteredInstance };
