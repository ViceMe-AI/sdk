'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
// Production entry (headless core): `import { createViceMe } from '@viceme-ai/sdk'`
import type { ViceMeClient } from '@viceme-ai/sdk';
// Test adapter (deterministic mock transport — dev/demo only):
import { createMemoryTransport, createTestViceMe } from '@viceme-ai/sdk/testing';

/**
 * Next.js fixture for the ViceMe SDK core (B0.1).
 *
 * The client lives in a client component (the SDK is a browser library);
 * Next.js only provides the page shell. Protocol, session, and error model
 * are the same headless core used by the CDN loader and static ESM pages.
 *
 * Runs against the mock transport until the public session API is live (B1).
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

export default function Page() {
  const clientRef = useRef<ViceMeClient | null>(null);
  const [state, setState] = useState<'idle' | 'creating' | 'ready' | 'failed' | 'destroyed'>(
    'idle',
  );

  const init = useCallback(async () => {
    setState('creating');
    const client = createDemoClient();
    clientRef.current = client;
    try {
      await client.ready();
      setState('ready');
    } catch {
      setState('failed');
    }
  }, []);

  const destroy = useCallback(() => {
    clientRef.current?.destroy();
    clientRef.current = null;
    setState('destroyed');
  }, []);

  useEffect(() => destroy, [destroy]);

  return (
    <main style={{ maxWidth: '40rem', margin: '2rem auto' }}>
      <h1>ViceMe SDK — Next.js</h1>
      <p>
        Same headless core as the CDN loader and static ESM entry; Next.js only provides the shell.
      </p>
      <p>
        client state: <code>{clientRef.current?.state ?? 'none'}</code> · page state:{' '}
        <code>{state}</code>
      </p>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={init} disabled={state === 'creating' || state === 'ready'}>
          Initialize client
        </button>
        <button onClick={destroy} disabled={!clientRef.current}>
          Destroy client
        </button>
      </div>
    </main>
  );
}
