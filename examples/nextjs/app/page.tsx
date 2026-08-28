'use client';

import { useEffect, useRef, useState } from 'react';
import { createViceMe } from '@viceme-ai/sdk';
import { mountDanmaku } from '@viceme-ai/sdk/danmaku';
import { mountTip } from '@viceme-ai/sdk/tip';

export default function Page() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'mounting' | 'ready' | 'failed'>('mounting');

  useEffect(() => {
    const client = createViceMe({ workKey: 'wrk_public_example', region: 'cn' });
    let disposed = false;
    const mounted: Array<{ destroy(): void }> = [];

    void (async () => {
      await client.ready();
      const target = hostRef.current;
      if (!target) return;
      const results = await Promise.allSettled([
        mountDanmaku(client, { target, theme: 'auto' }),
        mountTip(client, { target, theme: 'auto' }),
      ]);
      const ready = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      if (disposed) ready.forEach((handle) => handle.destroy());
      else if (ready.length > 0) {
        mounted.push(...ready);
        setState('ready');
      } else setState('failed');
    })().catch(() => {
      if (!disposed) setState('failed');
    });

    return () => {
      disposed = true;
      mounted.forEach((handle) => handle.destroy());
      client.destroy();
    };
  }, []);

  return (
    <main style={{ maxWidth: '40rem', margin: '2rem auto' }}>
      <h1>ViceMe hosted engagement</h1>
      <p>
        Client state: <code>{state}</code>. The external SDK has no Session or checkout surface.
      </p>
      <button type="button">Host-page action</button>
      <div ref={hostRef} />
    </main>
  );
}
