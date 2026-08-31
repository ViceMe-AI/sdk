# @viceme-ai/sdk

ViceMe browser SDK for Shop-hosted engagement and origin-bound Website Work access.

The latest published package is `0.4.0`, which contains Website Access v2 but
not Headless Tip. This source tree keeps the `0.4.0` development baseline while
the independent release PR owns the atomic `0.5.0` version, manifest, and
changelog update. Publication remains blocked while the repository has
`LICENSE-PENDING.md` instead of an approved `LICENSE`.

## Install

```bash
pnpm add @viceme-ai/sdk
```

## Static HTML

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

The feature declaration accepts `danmaku`, `tip`, or both without whitespace or
duplicates.

The Shop `/viceme-sdk/v1/*` proxy serves one configured exact release. It is
distinct from the direct S3 `v1/viceme.min.js` fixed bootstrap, which reads
`-/aliases/v1` before loading an immutable exact-version directory.

With CSP, allow the exact regional Shop origin in `script-src`, `connect-src`,
and `frame-src`, and keep `object-src 'none'`. A nonce with `'strict-dynamic'`
may authorize dynamic scripts, but the other directives still need exact
origins. Do not use `*` or a ViceMe subdomain wildcard.

## ESM

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

mounted.forEach((handle) => handle.destroy());
client.destroy();
```

Run those cleanup calls from the owning component's unmount path or another
explicit lifecycle boundary, not from `pagehide` (which also covers bfcache).

`createViceMe` and `ready()` are purely local and never contact Shop. A live client reports
build support for `danmaku` and `tip`; Shop remains authoritative for whether a
Work enables either capability. The hosted `/embed/danmaku` iframe uses Shop's
internal SDK to read and create anonymous messages through
`/v1/danmaku/messages`. The `/widget/tip/<workKey>` iframe owns confirmation,
payment, risk, and result authority. Visitors do not sign in to ViceMe and are
anonymous to the creator; the observed parent Origin is attribution rather than
an authorization gate.

Pass a selected public pair value for Tip: `keys.test` is `wrk_test_...` and
`keys.live` is `wrk_live_...`. Legacy `wrk_...` keys remain accepted for
Danmaku compatibility, but Tip rejects them locally.

Access operations establish a short-lived, memory-only Work session on first
use. They expose `client.auth`, `client.access`, and `client.checkout`; login,
explicit follow, and hosted checkout remain ViceMe-owned UI. The host never
receives a general ViceMe session or payment credential. Tests can inject a
deterministic transport and presenter through `@viceme-ai/sdk/testing`.

```ts
const decisions = await client.access.checkMany(['members', 'pro-tools']);
if (!decisions['pro-tools']?.allowed) {
  await client.access.require('pro-tools');
}
```

The Tip subpath exports `TipPaidDetail` and `TipWidgetCloseDetail` for the
sanitized `viceme:tip-paid` and `viceme:widget-close` `CustomEvent` details.
`TipPaidDetail` contains only `status`, trusted `work.id/title`, amount, and CNY;
it contains no key, provider, order number, token, or transaction identifier.

The danmaku mount hashes the canonical page URL locally, combines it with a 10%
scroll bucket, and sends only the opaque anchor to the hosted iframe. Destroying
the mount removes its nodes, listeners, debounce timer, and location poll.

The Tip mount sends no amount, provider, token, or application ID. It enables
interaction only after a trusted resize handshake. Shop resets its hosted
payment surface on Escape before sending close; the SDK forwards sanitized
close and paid notifications, and removes its iframe, timer, media listener,
and message listener on destroy.

## Headless Tip

This additive API targets `0.5.0`. Do not expect `createTip` or
`@viceme-ai/sdk/tip/testing` from the immutable npm `0.4.0` package.

```ts
import { createViceMe } from '@viceme-ai/sdk';
import { createTip } from '@viceme-ai/sdk/tip';

const client = createViceMe({ workKey: 'wrk_live_demo', region: 'cn' });
const tip = createTip(client);
const config = await tip.getConfig();

button.addEventListener('click', async () => {
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

Call `destroyTip()` from the owning component or route cleanup. Do not bind it
to `pagehide`, because that event also fires when a page enters the bfcache.

`getConfig()` strictly parses the credential-free regional
`GET /v1/work-sdk/<encoded-workKey>/tip-config` response. Call `open()` directly
from user activation so it can create its secure full-screen frame in the same
call stack. Only `PAID`, `CANCELLED`, and `UNKNOWN` cross back; no order number,
token, payment action, or transaction ID is exposed. `scene`, `metadata`, and
`testMode` are rejected or absent from the API.

The config `environment` remains server-authoritative. The SDK checks only that
`wrk_test_...` is paired with `SANDBOX` and `wrk_live_...` with `PRODUCTION`, and
rejects inconsistent responses.

The first Tip release is CN/CNY only. `region: 'global'` fails locally with
`CAPABILITY_DISABLED` without a config request or iframe. Anonymous Tip does not
use the legacy WeChat JSAPI user/OpenID path.

`TIP_CONFIG_INVALID` is a non-retryable Shop/SDK contract mismatch and should be
reported rather than retried. `TIP_OPEN_IN_PROGRESS` means the existing call
must settle first. `TIP_READY_TIMEOUT` is retryable after the failed call has
cleaned itself up. On every component or route unmount, call `tip.destroy()`
before `client.destroy()` so an in-flight flow settles as `UNKNOWN` and leaves
no portal or message listener behind.

Immutable exact-version CDN ESM exports the same implementation from
`<origin>/viceme-sdk/<version>/index.js` and `tip.js` without adding a `window`
global.

Use the scoped fake in components and Storybook:

```ts
import { createTestTip } from '@viceme-ai/sdk/tip/testing';

const paid = createTestTip({ config, outcome: 'PAID' });
const failed = createTestTip({ config, outcome: new Error('fixture failure') });
```

The config may also be an `Error`. `SANDBOX` is always supplied by server config
for a test Work, never by a production SDK switch.
