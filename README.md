# ViceMe SDK

Browser SDK for mounting ViceMe's Shop-hosted danmaku and Tip capabilities and
for adding server-authoritative login, follow, and paid access gates to a
published creator website.

- **Package**: [`@viceme-ai/sdk`](./packages/sdk)
- **Hosted features**: `danmaku` and `tip`
- **Website access**: authentication, explicit creator follow, and one-time paid unlock
- **Status**: `0.x`; the normal `dev -> main` release workflow owns versioning

Shop resolves `workKey` through `WorkSdkAccess`; the Work, verified embedding
Origin, and requested feature must be active. Website access establishes
short-lived in-memory Work and user sessions. Login never follows a creator
automatically, and payment return parameters never grant access.

## Static HTML

Use the complete snippet returned by ViceMe for the selected Shop region:

```html
<div id="viceme-engagement"></div>
<script
  defer
  src="https://viceme.cn/viceme-sdk/v1/viceme.min.js"
  data-viceme-work="wrk_public_xxx"
  data-viceme-region="cn"
  data-viceme-features="danmaku,tip"
  data-viceme-target="#viceme-engagement"
  data-viceme-theme="auto"
></script>
```

`data-viceme-features` is required. It accepts `danmaku`, `tip`, or each once in
a comma-separated list; the loader normalizes combined declarations to
`danmaku,tip`. Whitespace, duplicates, unknown names, and omitted declarations
fail closed without mounting.

The loader reads its same-release `manifest.json`, loads only the requested
`danmaku.js` and/or `tip.js` plus manifest-referenced `chunks/*.js`, then mounts
each capability independently. Repeating the same work, feature, and target
reuses the existing client and mount.

`https://viceme.cn/viceme-sdk/v1/*` is the Shop asset proxy, not the mutable S3
alias directory. Shop configures that proxy to one exact release and directly
serves the complete `viceme.min.js`, `manifest.json`, `danmaku.js`, `tip.js`,
and hashed chunk set under `/v1/*`; a missing sibling manifest is a deployment
error and fails closed. Direct storage has a separate topology:

```text
https://s3.viceme.cn/viceme-sdk/v1/viceme.min.js       fixed bootstrap
https://s3.viceme.cn/viceme-sdk/-/aliases/v1           version pointer
https://s3.viceme.cn/viceme-sdk/<version>/...           exact release
```

For a nonce-based CSP, preserve the host's existing directives and allow only
the exact regional Shop origin used by the snippet: `script-src` for the entry
and dynamically imported chunks, `connect-src` for `manifest.json`, and
`frame-src` for `/embed/danmaku` and `/widget/tip/<workKey>`. Keep
`object-src 'none'`; do not add `*` or a ViceMe subdomain wildcard. A typical CN
policy adds `https://viceme.cn` to all three allowlists (or uses the request
nonce plus `'strict-dynamic'` for script loading). A page that intentionally
uses the direct S3 alias instead must put the exact `https://s3.viceme.cn`
origin in `script-src` and `connect-src`, while `frame-src` remains
`https://viceme.cn`.

## npm / Bundlers

```bash
pnpm add @viceme-ai/sdk
```

```ts
import { createViceMe } from '@viceme-ai/sdk';
import { mountDanmaku } from '@viceme-ai/sdk/danmaku';
import { mountTip } from '@viceme-ai/sdk/tip';

const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
await client.ready();

const target = document.querySelector('#viceme-engagement');
if (!target) throw new Error('ViceMe target missing');

const results = await Promise.allSettled([
  mountDanmaku(client, { target, theme: 'auto' }),
  mountTip(client, { target, theme: 'auto' }),
]);
const mounted = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

function unmountViceMe() {
  mounted.forEach((handle) => handle.destroy());
  client.destroy();
}
```

Call `unmountViceMe()` when the owning component unmounts or an explicit widget
lifecycle ends. Do not bind cleanup to `pagehide`; that event also fires for
pages entering the back/forward cache.

`createViceMe({ workKey, region })` validates configuration and initializes a
local lifecycle only. It performs no network request.

## Website Access

Configure the Website Work and its follow or paid features through the ViceMe
publish flow first. Host code only consumes the returned `workKey` and feature
keys:

```ts
const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
const features = await client.access.getFeatures();
const memberFeature = features.find((feature) => feature.featureKey === 'member-content');

async function openProtectedContent() {
  const decision = await client.access.require('member-content');
  if (!decision.allowed) return;
  await openMemberContent();
}
```

`access.require()` follows the Shop decision: sign in, ask for separate follow
consent, or open Hosted Checkout. It rechecks server state before returning an
allowed decision. Creator consent UI shows identity and published work count,
but does not request or render recent work covers.

## Public Surface

```ts
type ViceMeRegion = 'cn' | 'global';
type ViceMeClientState = 'CREATED' | 'READY' | 'DEGRADED' | 'DESTROYED';

interface ViceMeClient {
  readonly version: string;
  readonly workKey: string;
  readonly region: ViceMeRegion;
  readonly state: ViceMeClientState;
  readonly auth: AuthCapability;
  readonly access: AccessCapability;
  readonly checkout: CheckoutCapability;

  ready(): Promise<void>;
  hasCapability(name: string): boolean;
  destroy(): void;
}
```

The released package exports `@viceme-ai/sdk`, `@viceme-ai/sdk/testing`,
`@viceme-ai/sdk/danmaku`, and `@viceme-ai/sdk/tip`. The testing entry is for
injecting deterministic transports and presenters; production code uses the
main entry.

`@viceme-ai/sdk/tip` also exports `TipPaidDetail` and
`TipWidgetCloseDetail` for the sanitized `viceme:tip-paid` and
`viceme:widget-close` `CustomEvent` details.

## Runtime Boundary

- The loader fetches only `manifest.json`, requested capability entries, and
  referenced `chunks/*.js` beside `viceme.min.js`.
- The external SDK derives an opaque page-position anchor, creates the stage,
  responsive-width controls, and lazy modal iframes, validates bridge message
  origin/source, and owns cleanup.
- Shop Web owns `/embed/danmaku`, including rendering, keyboard behavior,
  reduced-motion behavior, and interaction.
- The Shop SDK inside that iframe calls anonymous `GET` and `POST`
  `/v1/danmaku/messages`. The third-party host and external SDK do not call the
  endpoint directly.
- The Tip mount uses `strict-origin` referrer policy and stays non-interactive
  until `/widget/tip/<workKey>` proves a registered parent Origin through a
  trusted resize message. Shop owns payment, login, provider, amount, and Escape
  close state; it resets the hosted payment surface before emitting close. The
  SDK validates and redispatches that close notification but does not require a
  host-page listener for the default close behavior.

## Development

```bash
pnpm install
pnpm check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[docs/RELEASE.md](./docs/RELEASE.md).
