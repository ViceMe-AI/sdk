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

`createViceMe` is purely local and never contacts Shop. A live client reports
only the `danmaku` capability. The hosted `/embed/danmaku` iframe uses Shop's
internal SDK to read and create anonymous messages through
`/v1/danmaku/messages`.

There is no public SDK Session, Bearer token, auth, follow, access, purchase,
or checkout surface, and no `@viceme-ai/sdk/testing` subpath.

The danmaku mount hashes the canonical page URL locally, combines it with a 10%
scroll bucket, and sends only the opaque anchor to the hosted iframe. Destroying
the mount removes its nodes, listeners, debounce timer, and location poll.
