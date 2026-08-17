# ViceMe SDK

Public, versioned SDK that lets any website — static HTML, browser-native ESM,
React, Next.js, or Agent-generated projects — load ViceMe capabilities (danmaku,
hosted checkout, …) through one shared headless core.

- **Package**: [`@viceme-ai/sdk`](./packages/sdk) — browser core, Work context,
  public session, and capability subpaths.
- **React**: `@viceme-ai/react` will be published as a thin binding on top of
  the same core once the first real hooks/components exist. It is deliberately
  **not** created empty in this repository.
- **Status**: `0.x` infrastructure phase. Danmaku is the first public
  capability; other subpaths are exported only after their public contracts
  are live.

## Install

```bash
pnpm add @viceme-ai/sdk
```

## Usage

### Static HTML (CDN auto-loader)

```text
<script
  defer src="https://s3.viceme.cn/viceme-sdk/v1/viceme.min.js" data-viceme-work="wrk_public_xxx" data-viceme-region="cn"
  data-viceme-features="danmaku" data-viceme-target="body"
  data-viceme-theme="auto"></script>
```

The loader mounts an isolated hosted overlay, derives the current page and
10%-range scroll anchor automatically, and leaves the host application in
control of its own content and navigation.

### Browser-native ESM

```html
<script type="module">
  import { createViceMe } from 'https://s3.viceme.cn/viceme-sdk/1.0.0/index.js';

  const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
  await client.ready();

  window.addEventListener('pagehide', () => client.destroy());
</script>
```

### npm / bundler

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

### Testing your integration

```ts
import { createTestViceMe, createMemoryTransport } from '@viceme-ai/sdk/testing';

const transport = createMemoryTransport({
  work: { key: 'wrk_test', capabilities: ['fixture'] },
});

const client = createTestViceMe({
  workKey: 'wrk_test',
  region: 'cn',
  transport,
});

await client.ready();
```

## Public API surface (0.x)

```ts
type ViceMeRegion = 'cn' | 'global';

interface ViceMeClient {
  readonly version: string;
  readonly workKey: string;
  readonly region: ViceMeRegion;
  readonly state: 'CREATED' | 'INITIALIZING' | 'READY' | 'DEGRADED' | 'FAILED' | 'DESTROYED';

  ready(): Promise<void>;
  hasCapability(name: string): boolean;
  destroy(): void;
}

interface ViceMeMountedInstance {
  readonly instanceKey: string;
  readonly capability: string;
  destroy(): void;
}
```

Consumers branch on stable `ViceMeError.code` values only — never on error
messages. Errors never contain provider payloads, tokens, cookies, or internal
stacks.

## Repository layout

```text
packages/sdk      @viceme-ai/sdk core, testing adapter, CDN auto-loader
examples/         static-html, react-vite, nextjs fixtures
scripts/          manifest, tarball audit, public-surface verification
contracts/        public API contract snapshots (added in B0.2)
```

## Development

```bash
pnpm install
pnpm check   # format + lint + typecheck + contract drift + test + build + browser tests + tarball audit
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and capability
module template, and [docs/RELEASE.md](./docs/RELEASE.md) for the release and
CDN promotion runbook.

## Security

See [SECURITY.md](./SECURITY.md). Please do not open issues containing secrets
or payment data.
