import { clientDestroyed } from '../core/errors.ts';
import type { TipClient, TipConfig, TipOpenOptions, TipOpenResult } from './index.ts';
import { parseTipOpenOptions, tipOptionInvalid } from './validation.ts';

export type TipTestOutcome = 'PAID' | 'CANCELLED' | 'UNKNOWN' | Error;

export interface TipTestOptions {
  config: TipConfig | Error;
  outcome: TipTestOutcome;
}

/** Deterministic TipClient fake for component tests and Storybook stories. */
export function createTestTip(options: TipTestOptions): TipClient {
  const config = options.config instanceof Error ? options.config : copyConfig(options.config);
  const outcome = options.outcome;
  let destroyed = false;

  return {
    getConfig(): Promise<TipConfig> {
      if (destroyed) return Promise.reject(clientDestroyed());
      if (config instanceof Error) return Promise.reject(config);
      return Promise.resolve(copyConfig(config));
    },

    open(openOptions: TipOpenOptions): Promise<TipOpenResult> {
      if (destroyed) return Promise.reject(clientDestroyed());
      let validated: TipOpenOptions;
      try {
        validated = parseTipOpenOptions(openOptions);
      } catch (error) {
        return Promise.reject(error);
      }
      if (config instanceof Error) return Promise.reject(config);
      if (validated.provider !== undefined && !config.providers.includes(validated.provider)) {
        return Promise.reject(tipOptionInvalid());
      }
      if (outcome instanceof Error) return Promise.reject(outcome);
      if (outcome === 'PAID') {
        return Promise.resolve({
          status: 'PAID',
          work: { ...config.work },
          amountCents: validated.amountCents,
          currency: 'CNY',
        });
      }
      return Promise.resolve({ status: outcome });
    },

    destroy(): void {
      destroyed = true;
    },
  };
}

function copyConfig(config: TipConfig): TipConfig {
  return {
    work: { ...config.work },
    workKey: config.workKey,
    environment: config.environment,
    currency: config.currency,
    amount: { ...config.amount },
    providers: [...config.providers],
  };
}
