# @viceme-ai/sdk

Public ViceMe browser SDK: headless core, public session, and capability
subpaths for static HTML, browser-native ESM, React/Next.js, and
Agent-generated sites.

## Install

```bash
pnpm add @viceme-ai/sdk
```

## Usage

```ts
import { createViceMe } from '@viceme-ai/sdk';

const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
await client.ready();

if (client.hasCapability('danmaku')) {
  const { mountDanmaku } = await import('@viceme-ai/sdk/danmaku');
  const danmaku = await mountDanmaku(client, {
    target: document.body,
    theme: 'auto',
  });
}

client.destroy();
```

Static HTML sites can use the CDN auto-loader instead — see the
[repository README](https://github.com/ViceMe-AI/sdk).

## Testing your integration

```ts
import { createTestViceMe, createMemoryTransport } from '@viceme-ai/sdk/testing';

const client = createTestViceMe({
  workKey: 'wrk_test',
  region: 'cn',
  transport: createMemoryTransport({
    work: { key: 'wrk_test', capabilities: ['fixture'] },
  }),
});
await client.ready();
```

Static HTML uses the four-line CDN loader shown in the repository README. The
danmaku capability automatically hashes the canonical page URL and combines it
with a 10% scroll bucket; the full host URL is not sent to the hosted iframe.

Consumers branch on stable `ViceMeError.code` values only — never on error
messages. Status: `0.x` infrastructure phase; additional capability subpaths
land as their public API contracts go live.
