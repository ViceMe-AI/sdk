# @viceme-ai/sdk

PUBLIC-only ViceMe browser SDK for the Shop-hosted danmaku overlay.

## Install

```bash
pnpm add @viceme-ai/sdk
```

## Static HTML

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

The feature declaration must be exactly `danmaku`.

The `viceme.cn/viceme-sdk/v1/*` Shop proxy directly exposes one configured
exact release, including the loader, manifest, danmaku entry, and hashed
chunks. It is distinct from the direct S3 `v1/viceme.min.js` alias, whose fixed
bootstrap reads `-/aliases/v1` before loading an exact-version directory.

With CSP, allow the exact regional Shop origin in `script-src`, `connect-src`,
and `frame-src`, and keep `object-src 'none'`. A nonce with `'strict-dynamic'`
may authorize dynamic scripts, but `connect-src` and `frame-src` still need the
exact origin. Do not use `*` or a ViceMe subdomain wildcard.

## ESM

```ts
import { createViceMe } from '@viceme-ai/sdk';
import { mountDanmaku } from '@viceme-ai/sdk/danmaku';

const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
await client.ready();

const mounted = await mountDanmaku(client, {
  target: document.body,
  theme: 'auto',
});

mounted.destroy();
client.destroy();
```

Run those cleanup calls from the owning component's unmount path or another
explicit lifecycle boundary, not from `pagehide` (which also covers bfcache).

`createViceMe` is purely local and never contacts Shop. A live client reports
only the `danmaku` capability. The hosted `/embed/danmaku` iframe uses Shop's
internal SDK to read and create anonymous messages through
`/v1/danmaku/messages`.

There is no public SDK Session, Bearer token, auth, follow, access, purchase,
or checkout surface, and no `@viceme-ai/sdk/testing` subpath.

The danmaku mount hashes the canonical page URL locally, combines it with a 10%
scroll bucket, and sends only the opaque anchor to the hosted iframe. Destroying
the mount removes its nodes, listeners, debounce timer, and location poll.
