# @viceme-ai/sdk

PUBLIC-only ViceMe browser SDK for Shop-hosted danmaku and Tip capabilities.

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
  data-viceme-work="wrk_public_xxx"
  data-viceme-region="cn"
  data-viceme-features="danmaku,tip"
  data-viceme-target="#viceme-engagement"
  data-viceme-theme="auto"
></script>
```

The feature declaration accepts `danmaku`, `tip`, or both without whitespace or
duplicates.

The `viceme.cn/viceme-sdk/v1/*` Shop proxy directly exposes one configured
exact release, including the loader, manifest, danmaku and Tip entries, and
hashed chunks. It is distinct from the direct S3 `v1/viceme.min.js` alias,
whose fixed bootstrap reads `-/aliases/v1` before loading an exact-version
directory.

With CSP, allow the exact regional Shop origin in `script-src`, `connect-src`,
and `frame-src`, and keep `object-src 'none'`. A nonce with `'strict-dynamic'`
may authorize dynamic scripts, but `connect-src` and `frame-src` still need the
exact origin. Do not use `*` or a ViceMe subdomain wildcard.

## ESM

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

mounted.forEach((handle) => handle.destroy());
client.destroy();
```

Run those cleanup calls from the owning component's unmount path or another
explicit lifecycle boundary, not from `pagehide` (which also covers bfcache).

`createViceMe` is purely local and never contacts Shop. A live client reports
build support for `danmaku` and `tip`; Shop remains authoritative for whether a
Work enables either capability. The hosted `/embed/danmaku` iframe uses Shop's
internal SDK to read and create anonymous messages through
`/v1/danmaku/messages`. The `/widget/tip/<workKey>` iframe handles login and
payment only after its exact parent Origin is registered.

There is no public SDK Session, Bearer token, auth, follow, access, purchase,
or checkout surface, and no `@viceme-ai/sdk/testing` subpath.
The Tip subpath exports `TipPaidDetail` and `TipWidgetCloseDetail` for the
sanitized `viceme:tip-paid` and `viceme:widget-close` `CustomEvent` details.

The danmaku mount hashes the canonical page URL locally, combines it with a 10%
scroll bucket, and sends only the opaque anchor to the hosted iframe. Destroying
the mount removes its nodes, listeners, debounce timer, and location poll.

The Tip mount sends no amount, provider, token, or application ID. It enables
interaction only after a trusted resize handshake. Shop resets its hosted
payment surface on Escape before sending close; the SDK forwards sanitized
close and paid notifications, and removes its iframe, timer, media listener,
and message listener on destroy.
