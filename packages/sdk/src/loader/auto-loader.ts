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
 * 5. Create the local client embedded in this loader, then load the
 *    requested same-version capability chunks declared by the manifest.
 * 6. Mount; handles land in an internal registry.
 * 7. Re-running the same instance key returns the original handle — no
 *    duplicate clients, subscriptions, or DOM.
 * 8. A failing mount keeps the host page working and degrades only its client.
 * 9. `pagehide` never auto-destroys (bfcache); cleanup happens on explicit
 *    `destroy()` only.
 *
 * The loader never writes localStorage, cookies, global CSS, or globals other
 * than the fixed `window.ViceMe.versions.vN` namespace.
 */

import { parseLoaderAttributes, type LoaderAttributes, type LoaderFeature } from './attributes.ts';
import { LoaderRegistry, clientKeyOf, type RegisteredInstance } from './registry.ts';
import type { CapabilityMountHandle, CapabilityMountFunction } from '../capability-mount.ts';
import { dispatchViceMeEvent, type VicemeErrorDetail } from '../browser-events.ts';
import { clientDestroyed, configInvalid, ViceMeError } from '../core/errors.ts';
import {
  markClientDegraded,
  type ViceMeClient,
  type ViceMeMountedInstance,
} from '../core/client.ts';
import { createViceMe } from '../index.ts';
import { API_MAJOR, SDK_VERSION } from '../version.ts';

export interface ReleaseManifest {
  version: string;
  apiMajor: number;
  loader: string;
  features: Record<string, string>;
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
const CAPABILITY_MOUNT_TIMEOUT_MS = 8_000;
const FEATURE_PATHS: Readonly<Record<LoaderFeature, string>> = {
  danmaku: 'danmaku.js',
  tip: 'tip.js',
};
const MOUNT_EXPORTS: Readonly<Record<LoaderFeature, 'mountDanmaku' | 'mountTip'>> = {
  danmaku: 'mountDanmaku',
  tip: 'mountTip',
};

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
      for (const controller of entry?.pendingMounts ?? []) controller.abort();
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
  return { manifest: await parseManifest(response), baseUrl: manifestUrl };
}

function fetchWithTimeout(url: URL): Promise<Response> {
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(MANIFEST_TIMEOUT_MS)
      : undefined;
  return fetch(url, { credentials: 'omit', signal });
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
  if (manifest.version !== SDK_VERSION) {
    throw configInvalid('Release manifest version does not match this loader.');
  }
  if (manifest.apiMajor !== API_MAJOR) {
    throw configInvalid('Release manifest major version does not match this loader.');
  }
  const featureNames = Object.keys(manifest.features).sort();
  if (
    featureNames.length !== 2 ||
    featureNames[0] !== 'danmaku' ||
    featureNames[1] !== 'tip' ||
    manifest.features.danmaku !== FEATURE_PATHS.danmaku ||
    manifest.features.tip !== FEATURE_PATHS.tip
  ) {
    throw configInvalid('Release manifest features must be exactly danmaku.js and tip.js.');
  }
  return manifest;
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'CONFIG_INVALID',
  'CAPABILITY_DISABLED',
  'CLIENT_DESTROYED',
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

function withCapabilityDeadline<T>(
  operation: Promise<T>,
  controller: AbortController,
  capability: LoaderFeature,
): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(clientDestroyed());
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timeout = globalThis.setTimeout(() => {
      reject(
        new ViceMeError({
          code: 'INTERNAL_ERROR',
          message: `Capability "${capability}" did not load and mount in time.`,
          retryable: true,
          capability,
        }),
      );
      controller.abort();
    }, CAPABILITY_MOUNT_TIMEOUT_MS);
  });
  return Promise.race([operation, cancellation]).finally(() => {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  });
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
    try {
      client = createViceMe({
        workKey: attributes.workKey,
        region: attributes.region,
      });
    } catch (error) {
      emitError(host, error, { clientKey });
      return;
    }
    const ready = client.ready();
    // Keep an unhandled-rejection-free copy on the registry entry; failures
    // are reported through this loader run and via whenReady().
    void ready.catch(() => {});
    entry = { clientKey, client, ready, pendingMounts: new Set() };
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
  if (sharedState().registry.getClient(clientKey) !== entry) return;

  const mountCapability = async (capability: LoaderFeature): Promise<LoaderFeature | undefined> => {
    // Same client + capability + element: reuse the original handle.
    if (sharedState().registry.findInstance(clientKey, capability, host)) return undefined;

    const fileName = manifest.features[capability];
    if (typeof fileName !== 'string') {
      markClientDegraded(client);
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
      return undefined;
    }

    const controller = new AbortController();
    entry.pendingMounts.add(controller);
    try {
      const operation = (async (): Promise<CapabilityMountHandle> => {
        const chunkUrl = new URL(fileName, releaseBase);
        const module = (await import(/* @vite-ignore */ chunkUrl.href)) as Record<string, unknown>;
        const exportName = MOUNT_EXPORTS[capability];
        const mount = module[exportName];
        if (typeof mount !== 'function') {
          throw configInvalid(`Capability chunk "${capability}" does not export ${exportName}().`);
        }
        if (sharedState().registry.getClient(clientKey) !== entry) throw clientDestroyed();
        return (await (mount as CapabilityMountFunction)(client, {
          target: host,
          theme: attributes.theme,
          signal: controller.signal,
        })) as CapabilityMountHandle;
      })();
      const raw = await withCapabilityDeadline(operation, controller, capability);
      if (sharedState().registry.getClient(clientKey) !== entry) {
        raw.destroy();
        return undefined;
      }
      const instance = sharedState().registry.registerInstance(clientKey, capability, host, raw);
      dispatchViceMeEvent(host, 'viceme:capability-ready', {
        clientKey,
        instanceKey: instance.instanceKey,
        capability,
        version: manifest.version,
      });
      return capability;
    } catch (error) {
      if (sharedState().registry.getClient(clientKey) !== entry) return undefined;
      // Only this capability's partial state is discarded; everything else
      // (including the host page) keeps working.
      markClientDegraded(client);
      emitError(host, error, { clientKey, capability });
      return undefined;
    } finally {
      entry.pendingMounts.delete(controller);
    }
  };

  const mounted = (await Promise.all(attributes.features.map(mountCapability))).filter(
    (capability): capability is LoaderFeature => capability !== undefined,
  );

  if (mounted.length > 0 && sharedState().registry.getClient(clientKey) === entry) {
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
 * and never create duplicate clients or DOM.
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
