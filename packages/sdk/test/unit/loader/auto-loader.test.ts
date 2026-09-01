import { describe, expect, it } from 'vitest';
// Importing the module runs `bootstrap()` once: with no currentScript and no
// explicit script[data-viceme-loader], it must stay a no-op.
import { ensureNamespace, type ViceMeBrowserGlobal } from '../../../src/loader/auto-loader.ts';

describe('auto-loader module side effects', () => {
  it('does not create the window namespace when no loader script exists', () => {
    // The import-time bootstrap ran against this DOM-less context and must
    // not have registered anything.
    expect((globalThis as { ViceMe?: ViceMeBrowserGlobal }).ViceMe).toBeUndefined();
  });
});

describe('ensureNamespace', () => {
  it('installs a non-enumerable, idempotent v1 namespace', () => {
    const ns = ensureNamespace('0.1.0');
    const holder = globalThis as { ViceMe?: ViceMeBrowserGlobal };
    expect(holder.ViceMe).toBeDefined();
    expect(holder.ViceMe!.versions.v1).toBe(ns);
    expect(ns.version).toBe('0.1.0');

    expect(Object.keys(holder.ViceMe!)).not.toContain('versions');

    // Second install returns the existing namespace.
    expect(ensureNamespace('0.2.0')).toBe(ns);
  });

  it('whenReady rejects for unknown client keys', async () => {
    const ns = ensureNamespace('0.1.0');
    await expect(ns.whenReady('v1+cn+wrk_test_nope')).rejects.toSatisfy((e: unknown) => {
      return (e as { code?: string }).code === 'CONFIG_INVALID';
    });
  });

  it('getInstance/destroyInstance are safe for unknown keys', () => {
    const ns = ensureNamespace('0.1.0');
    expect(ns.getInstance('nope')).toBeUndefined();
    expect(() => ns.destroyInstance('nope')).not.toThrow();
    expect(() => ns.destroyClient('v1+cn+wrk_test_nope')).not.toThrow();
  });
});
