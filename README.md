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

`https://viceme.cn/viceme-sdk/v1/*` is the Shop asset proxy, not the mutable S3
alias directory. Shop configures that proxy to one exact release and directly
serves the complete `viceme.min.js`, `manifest.json`, `danmaku.js`, and hashed
chunk set under `/v1/*`; a missing sibling manifest is a deployment error and
fails closed. Direct storage has a separate topology:

```text
https://s3.viceme.cn/viceme-sdk/v1/viceme.min.js       fixed bootstrap
https://s3.viceme.cn/viceme-sdk/-/aliases/v1           version pointer
https://s3.viceme.cn/viceme-sdk/<version>/...           exact release
```

For a nonce-based CSP, preserve the host's existing directives and allow only
the exact regional Shop origin used by the snippet: `script-src` for the entry
and dynamically imported chunks, `connect-src` for `manifest.json`, and
`frame-src` for `/embed/danmaku`. Keep `object-src 'none'`; do not add `*` or a
ViceMe subdomain wildcard. A typical CN policy adds `https://viceme.cn` to all
three allowlists (or uses the request nonce plus `'strict-dynamic'` for script
loading). A page that intentionally uses the direct S3 alias instead must put
the exact `https://s3.viceme.cn` origin in `script-src` and `connect-src`, while
`frame-src` remains `https://viceme.cn`.

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

function unmountViceMe() {
  mounted?.destroy();
  client.destroy();
}
```

Call `unmountViceMe()` when the owning component unmounts or an explicit widget
lifecycle ends. Do not bind cleanup to `pagehide`; that event also fires for
pages entering the back/forward cache.

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
  responsive-width controls, and lazy modal iframes, validates bridge message
  origin/source, and owns cleanup.
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
