import { useCallback, useEffect, useRef, useState } from 'react';
// Production entry (headless core): `import { createViceMe } from '@viceme-ai/sdk'`
import type { ViceMeClient } from '@viceme-ai/sdk';
// Test adapter (deterministic mock transport — dev/demo only):
import { createMemoryTransport, createTestViceMe } from '@viceme-ai/sdk/testing';

/**
 * React fixture for the ViceMe SDK core (B0.1).
 *
 * React only manages component lifecycle here: the client, session, error
 * model, and capability discovery all come from the same headless core that
 * static HTML and browser-native ESM consumers use. No React-specific
 * protocol exists — and when `@viceme-ai/react` ships, it will be a thin
 * binding over exactly this client.
 *
 * This fixture runs against the mock transport because the public API for
 * work sessions is not deployed yet (B1). Swap `createDemoClient` for the
 * commented production call once your work key and region are live.
 */
function createDemoClient(): ViceMeClient {
  return createTestViceMe({
    workKey: 'wrk_test',
    region: 'cn',
    transport: createMemoryTransport({
      work: { key: 'wrk_test', capabilities: ['fixture'] },
    }),
  });
}

// function createProductionClient(): ViceMeClient {
//   return createViceMe({ workKey: 'wrk_public_example', region: 'cn' });
// }

export default function App() {
  const clientRef = useRef<ViceMeClient | null>(null);
  const [state, setState] = useState<'idle' | 'creating' | 'ready' | 'failed' | 'destroyed'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const init = useCallback(async () => {
    setState('creating');
    setError(null);
    const client = createDemoClient();
    clientRef.current = client;
    try {
      await client.ready();
      setState('ready');
    } catch (cause) {
      setState('failed');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const destroy = useCallback(() => {
    clientRef.current?.destroy();
    clientRef.current = null;
    setState('destroyed');
  }, []);

  useEffect(() => destroy, [destroy]);

  const capabilities =
    state === 'ready' && clientRef.current
      ? ['fixture'].filter((name) => clientRef.current?.hasCapability(name))
      : [];

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '40rem', margin: '2rem auto' }}>
      <h1>ViceMe SDK — React + Vite</h1>
      <p>
        Same headless core as the CDN loader and browser ESM entry; React only owns component
        lifecycle.
      </p>
      <p>
        client state: <code>{clientRef.current?.state ?? 'none'}</code> · fixture page state:{' '}
        <code>{state}</code>
      </p>
      {error && (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      )}
      {state === 'ready' && <p>capabilities: {capabilities.join(', ') || 'none'}</p>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={init} disabled={state === 'creating' || state === 'ready'}>
          Initialize client
        </button>
        <button onClick={destroy} disabled={!clientRef.current}>
          Destroy client
        </button>
      </div>
      <p>
        <small>
          Note <code>createViceMe</code> is imported from the production entry; the demo button uses{' '}
          <code>createTestViceMe</code> with a memory transport until the public session API is live
          (B1).
        </small>
      </p>
    </main>
  );
}
