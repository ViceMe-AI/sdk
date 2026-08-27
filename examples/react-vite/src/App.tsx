import { useEffect, useRef, useState } from 'react';
import { createViceMe } from '@viceme-ai/sdk';
import { mountDanmaku } from '@viceme-ai/sdk/danmaku';

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'mounting' | 'ready' | 'failed'>('mounting');

  useEffect(() => {
    const client = createViceMe({ workKey: 'wrk_public_example', region: 'cn' });
    let disposed = false;
    let mounted: Awaited<ReturnType<typeof mountDanmaku>> | undefined;

    void (async () => {
      await client.ready();
      const target = hostRef.current;
      if (!target || !client.hasCapability('danmaku')) return;
      const next = await mountDanmaku(client, { target, theme: 'auto' });
      if (disposed) next.destroy();
      else {
        mounted = next;
        setState('ready');
      }
    })().catch(() => {
      if (!disposed) setState('failed');
    });

    return () => {
      disposed = true;
      mounted?.destroy();
      client.destroy();
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '40rem', margin: '2rem auto' }}>
      <h1>ViceMe hosted danmaku</h1>
      <p>
        Client state: <code>{state}</code>. <code>ready()</code> establishes the public work
        session; the mounted Shop iframe owns danmaku message API calls.
      </p>
      <button type="button">Host-page action</button>
      <div ref={hostRef} />
    </main>
  );
}
