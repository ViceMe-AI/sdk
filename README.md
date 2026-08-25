# ViceMe SDK

PUBLIC-only browser SDK for mounting ViceMe's Shop-hosted danmaku overlay on a
third-party page.

- **Package**: [`@viceme-ai/sdk`](./packages/sdk)
- **Hosted feature**: `danmaku` only
- **Status**: `0.x`; the normal `dev -> main` release workflow owns versioning

The external SDK has no Work Session, browser Bearer token, authentication,
follow, access gate, purchase, or checkout API. Shop validates that each
`workKey` belongs to an active SDK Work with an active `PUBLIC` danmaku feature.

## Static HTML

Use the complete snippet returned by ViceMe for the selected Shop region:

```html
<script
  defer
  src="https://viceme.cn/viceme-sdk/v1/viceme.min.js"
  data-viceme-work="wrk_public_xxx"
  data-viceme-region="cn"
  data-viceme-features="danmaku"
  data-viceme-target="body"
  data-viceme-theme="auto"
></script>
```

`data-viceme-features` is required and must be exactly `danmaku`. Unknown,
combined, or omitted feature declarations fail closed without mounting.

The loader reads its same-release `manifest.json`, loads `danmaku.js` and any
manifest-referenced `chunks/*.js`, then mounts one isolated overlay. Repeating
the same work, feature, and target reuses the existing client and mount.

## npm / Bundlers

```bash
pnpm add @viceme-ai/sdk
```

```ts
import { createViceMe } from '@viceme-ai/sdk';
import { mountDanmaku } from '@viceme-ai/sdk/danmaku';

const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
await client.ready();

const mounted = client.hasCapability('danmaku')
  ? await mountDanmaku(client, { target: document.body, theme: 'auto' })
  : null;

window.addEventListener('pagehide', () => {
  mounted?.destroy();
  client.destroy();
});
```

`createViceMe({ workKey, region })` validates configuration and initializes a
local lifecycle only. It performs no network request.

## Public Surface

```ts
type ViceMeRegion = 'cn' | 'global';
type ViceMeClientState = 'CREATED' | 'READY' | 'DEGRADED' | 'DESTROYED';

interface ViceMeClient {
  readonly workKey: string;
  readonly region: ViceMeRegion;
  readonly state: ViceMeClientState;

  ready(): Promise<void>;
  hasCapability(name: string): boolean; // true only for "danmaku" while alive
  destroy(): void;
}
```

The released package exports exactly `@viceme-ai/sdk` and
`@viceme-ai/sdk/danmaku`. There is no `@viceme-ai/sdk/testing` transport or
Session adapter.

## Runtime Boundary

- The loader fetches only `manifest.json`, `danmaku.js`, and referenced
  `chunks/*.js` beside `viceme.min.js`.
- The external SDK derives an opaque page-position anchor, creates the stage,
  controls, and lazy modal iframes, validates bridge message origin/source, and
  owns cleanup.
- Shop Web owns `/embed/danmaku`, including rendering, keyboard behavior,
  reduced-motion behavior, and interaction.
- The Shop SDK inside that iframe calls anonymous `GET` and `POST`
  `/v1/danmaku/messages`. The third-party host and external SDK do not call the
  endpoint directly.

## Development

```bash
pnpm install
pnpm check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[docs/RELEASE.md](./docs/RELEASE.md).
