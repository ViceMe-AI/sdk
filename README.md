# ViceMe SDK

Public, versioned SDK that lets any website — static HTML, browser-native ESM,
React, Next.js, or Agent-generated projects — load ViceMe capabilities (danmaku,
creator login, following, and hosted checkout) through one shared core.

- **Package**: [`@viceme-ai/sdk`](./packages/sdk) — browser core, Work context,
  public session, and capability subpaths.
- **React**: `@viceme-ai/react` will be published as a thin binding on top of
  the same core once the first real hooks/components exist. It is deliberately
  **not** created empty in this repository.
- **Status**: `0.x`. Creator access capabilities are backed by the committed
  Shop public API contract.

## Install

```bash
pnpm add @viceme-ai/sdk
```

## Usage

### Static HTML (CDN auto-loader)

```html
<div id="viceme-danmaku"></div>
<script
  defer
  src="https://s3.viceme.cn/viceme-sdk/v1/viceme.min.js"
  integrity="sha384-..."
  crossorigin="anonymous"
  data-viceme-work="wrk_public_xxx"
  data-viceme-region="cn"
  data-viceme-features="danmaku"
  data-viceme-target="#viceme-danmaku"
  data-viceme-theme="auto"
></script>
```

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

const decisions = await client.access.checkMany(['dingdong', 'emperor']);

// From a gated user gesture. A denied decision opens the site's presenter or
// the default in-page Web Component; follow/login/checkout require a second,
// explicit action inside that interface. Login and payment remain in the
// bottom sheet or modal instead of navigating the creator page.
await client.access.require('emperor');

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
  readonly auth: AuthCapability;
  readonly access: AccessCapability;
  readonly checkout: CheckoutCapability;
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
