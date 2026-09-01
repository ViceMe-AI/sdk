import { describe, expect, it, vi } from 'vitest';

import type { TipConfig } from '../../../src/tip/index.ts';
import { createTestTip } from '../../../src/tip/testing.ts';

const TIP_CONFIG: TipConfig = {
  work: { id: '00000000-0000-4000-8000-000000000001', title: 'Story work' },
  workKey: 'wrk_test_story',
  environment: 'SANDBOX',
  currency: 'CNY',
  amount: { minCents: 100, maxCents: 20_000, stepCents: 1 },
  providers: ['WECHAT_PAY'],
};

describe('createTestTip', () => {
  it('injects config and derives a contract-safe PAID result without browser effects', async () => {
    const fetchBefore = globalThis.fetch;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tip = createTestTip({ config: TIP_CONFIG, outcome: 'PAID' });

    await expect(tip.getConfig()).resolves.toEqual(TIP_CONFIG);
    await expect(tip.open({ amountCents: 880, provider: 'WECHAT_PAY' })).resolves.toEqual({
      status: 'PAID',
      work: TIP_CONFIG.work,
      amountCents: 880,
      currency: 'CNY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();

    tip.destroy();
    vi.stubGlobal('fetch', fetchBefore);
  });

  it.each(['CANCELLED', 'UNKNOWN'] as const)('injects a %s outcome', async (outcome) => {
    const tip = createTestTip({ config: TIP_CONFIG, outcome });

    await expect(tip.open({ amountCents: 880 })).resolves.toEqual({ status: outcome });
    tip.destroy();
  });

  it('injects config and open errors', async () => {
    const configError = new Error('config fixture failed');
    const openError = new Error('open fixture failed');
    const configFailure = createTestTip({ config: configError, outcome: 'UNKNOWN' });
    const openFailure = createTestTip({ config: TIP_CONFIG, outcome: openError });

    await expect(configFailure.getConfig()).rejects.toBe(configError);
    await expect(configFailure.open({ amountCents: 880 })).rejects.toBe(configError);
    await expect(openFailure.open({ amountCents: 880 })).rejects.toBe(openError);

    configFailure.destroy();
    openFailure.destroy();
  });

  it('is idempotently destroyable and rejects later calls', async () => {
    const tip = createTestTip({ config: TIP_CONFIG, outcome: 'PAID' });

    tip.destroy();
    tip.destroy();

    await expect(tip.getConfig()).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
    await expect(tip.open({ amountCents: 880 })).rejects.toMatchObject({
      code: 'CLIENT_DESTROYED',
    });
  });

  it('matches production option validation', async () => {
    const tip = createTestTip({ config: TIP_CONFIG, outcome: 'PAID' });

    await expect(
      tip.open({ amountCents: 880, metadata: { source: 'test' } } as never),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID', capability: 'tip' });
    await expect(tip.open({ amountCents: 880, provider: 'ALIPAY' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      capability: 'tip',
    });

    tip.destroy();
  });

  it('snapshots its deterministic outcome at creation', async () => {
    const options = { config: TIP_CONFIG, outcome: 'PAID' as const };
    const tip = createTestTip(options);
    (options as { outcome: 'PAID' | 'UNKNOWN' }).outcome = 'UNKNOWN';

    await expect(tip.open({ amountCents: 880 })).resolves.toMatchObject({ status: 'PAID' });

    tip.destroy();
  });
});
