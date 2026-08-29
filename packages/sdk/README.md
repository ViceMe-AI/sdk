# @myc666/viceme-sdk

Personal POC build of the ViceMe browser SDK for Open Tip and Headless testing.
This beta is fixed to `https://poc.viceme.cn` and is not a production release.

## Install

```bash
pnpm add @myc666/viceme-sdk@beta
```

## ESM

```ts
import { createViceMe } from '@myc666/viceme-sdk';
import { mountDanmaku } from '@myc666/viceme-sdk/danmaku';
import { mountTip } from '@myc666/viceme-sdk/tip';

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

`createViceMe` is purely local and never contacts Shop. A live client reports
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

There is no public SDK Session, Bearer token, auth, follow, access, order, or
payment data surface, and no generic `@viceme-ai/sdk/testing` subpath.
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

```ts
import { createViceMe } from '@myc666/viceme-sdk';
import { createTip } from '@myc666/viceme-sdk/tip';

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
import { createTestTip } from '@myc666/viceme-sdk/tip/testing';

const paid = createTestTip({ config, outcome: 'PAID' });
const failed = createTestTip({ config, outcome: new Error('fixture failure') });
```

The config may also be an `Error`. `SANDBOX` is always supplied by server config
for a test Work, never by a production SDK switch.
