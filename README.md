# ViceMe SDK

Browser SDK for mounting ViceMe's Shop-hosted danmaku and Tip capabilities and
for adding server-authoritative login, follow, and paid access gates to a
published creator website.

- **Package**: [`@viceme-ai/sdk`](./packages/sdk)
- **Hosted features**: `danmaku` and `tip`
- **Website access**: authentication, explicit creator follow, and one-time paid unlock
- **Status**: `0.x`; the normal `dev -> main` release workflow owns versioning
- **Latest published package**: `0.4.0` with Website Access v2; it does not contain Headless Tip
- **Current source target**: `0.5.0`, adding Headless Tip through a separate release PR

Shop resolves `workKey` through `WorkSdkAccess`; the Work, verified embedding
Origin, and requested feature must be active. Website access establishes
short-lived in-memory Work and user sessions. Login never follows a creator
automatically, and payment return parameters never grant access.
Headless Tip is a separate credentialless boundary: it does not expose the
Website Access token, user session, order, payment action, or provider
transaction data to the host page.

The source tree intentionally keeps `package.json` and `SDK_VERSION` at the
published `0.4.0` development baseline. The independent release PR will
atomically generate `0.5.0`, its runtime manifest, and changelog. That release
also remains fail closed while `LICENSE-PENDING.md` exists and no approved root
`LICENSE` has been committed.

## Static HTML

Use the complete snippet returned by ViceMe for the selected Shop region:

```html
<div id="viceme-engagement"></div>
<script
  defer
  src="https://viceme.cn/viceme-sdk/v1/viceme.min.js"
  data-viceme-work="wrk_live_demo"
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
serves the complete loader, manifest, capability entries, and hashed chunks.
Direct storage has a separate topology:

```text
https://s3.viceme.cn/viceme-sdk/v1/viceme.min.js       fixed bootstrap
https://s3.viceme.cn/viceme-sdk/-/aliases/v1           version pointer
https://s3.viceme.cn/viceme-sdk/<version>/...           exact ESM release
```

For a nonce-based CSP, preserve the host's existing directives and allow only
the exact regional Shop origin used by the snippet in `script-src`,
`connect-src`, and `frame-src`. Keep `object-src 'none'`; do not add `*` or a
ViceMe subdomain wildcard. A page using the direct S3 alias instead allows the
exact S3 origin in `script-src` and `connect-src`, while `frame-src` remains the
Shop origin.

## npm / Bundlers

```bash
pnpm add @viceme-ai/sdk
```

```ts
import { createViceMe } from '@viceme-ai/sdk';
import { mountDanmaku } from '@viceme-ai/sdk/danmaku';
import { mountTip } from '@viceme-ai/sdk/tip';

const client = createViceMe({ workKey: 'wrk_live_demo', region: 'cn' });
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
local lifecycle only. It performs no network request. Use the selected public
pair member: `keys.test` has a `wrk_test_...` value and `keys.live` has a
`wrk_live_...` value. Legacy `wrk_...` keys remain valid for Danmaku
compatibility, but the Tip capability rejects them locally.

## Headless Tip

Headless Tip is present in the current source tree and targets `0.5.0`; npm and
CN/GLOBAL immutable `0.5.0` artifacts do not exist until the release workflow
completes.

Use `createTip` when the host renders the amount and provider controls but Shop
must still own confirmation, payment, risk, and result authority:

```ts
import { createViceMe } from '@viceme-ai/sdk';
import { createTip } from '@viceme-ai/sdk/tip';

const client = createViceMe({ workKey: 'wrk_live_demo', region: 'cn' });
const tip = createTip(client);
const config = await tip.getConfig();

document.querySelector('#tip-button')?.addEventListener('click', async () => {
  const result = await tip.open({
    amountCents: config.amount.minCents,
    provider: config.providers[0],
    locale: 'zh-CN',
    appearance: 'auto',
  });
  console.log(result.status);
});

function destroyTip() {
  tip.destroy();
  client.destroy();
}
```

Call `open` directly from the click or keyboard activation handler. It creates
the secure frame synchronously, then waits for Shop's trusted handshake. A Tip
client permits one open flow at a time; `destroy()` removes its frame,
listeners, and timeout, and resolves an in-flight flow as `UNKNOWN`.
Call `destroyTip()` from the owning component or route cleanup, not `pagehide`.

`getConfig()` performs only this credential-free request against the CN Shop
Origin:

```text
GET /v1/work-sdk/<encoded-workKey>/tip-config
```

Its strictly parsed response contains only Work identity, `SANDBOX` or
`PRODUCTION`, CNY amount bounds, and enabled `WECHAT_PAY` / `ALIPAY` providers.
The server field remains authoritative; the SDK only rejects an inconsistent
`wrk_test_... + PRODUCTION` or `wrk_live_... + SANDBOX` response. Neither
`createTip` nor `open` accepts `testMode`, `scene`, or `metadata`.

The first Tip release is CN/CNY only. A Tip client configured with `region:
'global'` rejects locally with `CAPABILITY_DISABLED`; it does not request a
GLOBAL Tip endpoint or create an iframe.

Visitors do not sign in to ViceMe and are anonymous to the creator. ViceMe and
the payment provider retain only the payment, risk, and compliance facts they
need. Anonymous Tip does not use the legacy WeChat JSAPI user/OpenID path.

The only open results are:

```ts
type TipOpenResult =
  | {
      status: 'PAID';
      work: { id: string; title: string };
      amountCents: number;
      currency: 'CNY';
    }
  | { status: 'CANCELLED' }
  | { status: 'UNKNOWN' };
```

Order numbers, tokens, provider actions, and transaction identifiers never
cross the SDK boundary. The host page never calls an order API.

The npm entry and immutable CDN ESM entry are built from the same `tip.js`
implementation. Exact-version CDN imports do not install a `window` global:

```ts
import { createViceMe } from 'https://s3.viceme.cn/viceme-sdk/0.5.0/index.js';
import { createTip } from 'https://s3.viceme.cn/viceme-sdk/0.5.0/tip.js';
```

Use those exact URLs only after `0.5.0` is published and verified. Substituting
`0.4.0` is invalid because that immutable release does not export `createTip`.

For components and Storybook, use the isolated deterministic fake:

```ts
import { createTestTip } from '@viceme-ai/sdk/tip/testing';

const tip = createTestTip({ config, outcome: 'PAID' });
```

`config` may be a `TipConfig` or `Error`; `outcome` accepts `PAID`,
`CANCELLED`, `UNKNOWN`, or an `Error`. This test entry never changes production
`createTip` behavior.

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

The `0.5.0` target exports `@viceme-ai/sdk`, `@viceme-ai/sdk/testing`,
`@viceme-ai/sdk/danmaku`, `@viceme-ai/sdk/tip`, and
`@viceme-ai/sdk/tip/testing`. The generic testing entry injects deterministic
Website Access transports and presenters; the scoped Tip entry is an isolated
`TipClient` fake. Production code uses the main and capability entries.

`@viceme-ai/sdk/tip` also exports `TipPaidDetail` and
`TipWidgetCloseDetail` for the sanitized `viceme:tip-paid` and
`viceme:widget-close` `CustomEvent` details. The paid detail contains only
`status`, trusted `work.id/title`, `amountCents`, and `currency`.

## Runtime Boundary

- The loader fetches only `manifest.json`, requested capability entries, and
  referenced `chunks/*.js` beside `viceme.min.js`.
- Headless `getConfig` performs Tip's sole host-page data request. Headless
  `open` sends only channel, Work key, amount, optional provider, locale, and
  resolved light/dark appearance to the exact trusted frame.
- The external SDK derives an opaque page-position anchor, creates the stage,
  responsive-width controls, and lazy modal iframes, validates bridge message
  origin/source, and owns cleanup.
- Shop Web owns `/embed/danmaku`, including rendering, keyboard behavior,
  reduced-motion behavior, and interaction.
- The Shop SDK inside that iframe calls anonymous `GET` and `POST`
  `/v1/danmaku/messages`. The third-party host and external SDK do not call the
  endpoint directly.
- The Tip mount uses `strict-origin` referrer policy and stays non-interactive
  until `/widget/tip/<workKey>` proves its Work identity through a trusted resize
  message. Shop owns confirmation, payment, risk, provider, amount, and Escape
  close state; it resets the hosted payment surface before emitting close. The
  observed parent Origin is attribution, not a payment gate. The SDK validates
  and redispatches that close notification but does not require a host-page
  listener for the default close behavior.

## Development

```bash
pnpm install
pnpm check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[docs/RELEASE.md](./docs/RELEASE.md).
