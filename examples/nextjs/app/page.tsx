'use client';

import { useEffect, useRef, useState } from 'react';
import { createViceMe } from '@viceme-ai/sdk';
import { createTip, type TipClient, type TipConfig, type TipProvider } from '@viceme-ai/sdk/tip';

export default function Page() {
  const tipRef = useRef<TipClient | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [config, setConfig] = useState<TipConfig | null>(null);
  const [amountCents, setAmountCents] = useState(100);
  const [provider, setProvider] = useState<TipProvider | ''>('');
  const [tipStatus, setTipStatus] = useState<
    'idle' | 'opening' | 'PAID' | 'CANCELLED' | 'UNKNOWN' | 'failed'
  >('idle');

  useEffect(() => {
    const client = createViceMe({ workKey: 'wrk_test_example', region: 'cn' });
    const tip = createTip(client);
    tipRef.current = tip;
    let disposed = false;

    void tip
      .getConfig()
      .then((nextConfig) => {
        if (disposed) return;
        setConfig(nextConfig);
        setAmountCents(nextConfig.amount.minCents);
        setProvider(nextConfig.providers[0] ?? '');
        setState('ready');
      })
      .catch(() => {
        if (!disposed) setState('failed');
      });

    return () => {
      disposed = true;
      tip.destroy();
      if (tipRef.current === tip) tipRef.current = null;
      client.destroy();
    };
  }, []);

  function openHeadlessTip() {
    const tip = tipRef.current;
    if (!tip || !config) return;
    const pending = tip.open({
      amountCents,
      ...(provider ? { provider } : {}),
      locale: 'zh-CN',
      appearance: 'auto',
    });
    setTipStatus('opening');
    void pending
      .then((result) => {
        if (tipRef.current === tip) setTipStatus(result.status);
      })
      .catch(() => {
        if (tipRef.current === tip) setTipStatus('failed');
      });
  }

  return (
    <main style={{ maxWidth: '40rem', margin: '2rem auto' }}>
      <h1>ViceMe Headless Tip</h1>
      <p>
        Config state: <code>{state}</code>. The host renders controls while ViceMe owns confirmation
        and payment.
      </p>
      <label>
        Amount (fen)
        <input
          type="number"
          min={config?.amount.minCents}
          max={config?.amount.maxCents}
          step={config?.amount.stepCents}
          value={amountCents}
          disabled={!config}
          onChange={(event) => setAmountCents(event.currentTarget.valueAsNumber)}
        />
      </label>
      <label>
        Provider
        <select
          value={provider}
          disabled={!config}
          onChange={(event) => setProvider(event.currentTarget.value as TipProvider | '')}
        >
          <option value="">ViceMe chooses</option>
          {config?.providers.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={openHeadlessTip} disabled={!config || tipStatus === 'opening'}>
        Open Headless Tip
      </button>
      <p>
        Headless result: <code>{tipStatus}</code>
      </p>
    </main>
  );
}
