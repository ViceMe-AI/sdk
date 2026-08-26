# @viceme-ai/sdk

Public ViceMe browser SDK: headless core, public session, and capability
subpaths for static HTML, browser-native ESM, React/Next.js, and
Agent-generated sites.

## Install

```bash
pnpm add @viceme-ai/sdk
```

## Usage

```ts
import { createViceMe } from '@viceme-ai/sdk';

const client = createViceMe({ workKey: 'wrk_public_xxx', region: 'cn' });
await client.ready();

// Use server-authoritative titles and prices in the host site's existing
// Button/Card components. This does not open or customize ViceMe checkout.
const features = await client.access.getFeatures();
const emperor = features.find((feature) => feature.featureKey === 'emperor');

const access = await client.access.checkMany(['dingdong', 'emperor']);
if (access.dingdong.allowed) enableDingdong();
if (access.emperor.allowed) enableEmperor();

// Call from a user gesture. A denied decision opens the ViceMe
// bottom-sheet/in-page Web Component. Creator details and recent work covers appear
// above one authorization action; accepted authorization automatically follows.
const decision = await client.access.require('emperor');
if (decision.allowed) enableEmperor();

client.destroy();
```

When adding a host-side locked state or purchase entry, preserve the site's
existing component library, design tokens, responsive behavior, and feedback
patterns. Keep the original business action unchanged and call it only after
`access.require()` returns an allowed decision. Never hard-code a price from
local configuration; `getFeatures()` returns the current display price. The
ViceMe-owned authorization and checkout layer remains isolated and unchanged.

The SDK registers and mounts `<viceme-access-layer>` with isolated ViceMe-owned
styles. Authorization and checkout remain inside its iframe area and complete through
an origin- and channel-validated message; no browser popup, page navigation,
`confirm`, or `alert` is used. Custom site presenters and style inference are
not part of the current public contract. WeChat opens directly inside the frame,
and the checkout frame keeps a stable height while its content loads.

Static HTML sites can use the CDN auto-loader instead — see the
[repository README](https://github.com/ViceMe-AI/sdk).

## Testing your integration

```ts
import { createTestViceMe, createMemoryTransport } from '@viceme-ai/sdk/testing';

const client = createTestViceMe({
  workKey: 'wrk_test',
  region: 'cn',
  transport: createMemoryTransport({
    work: { key: 'wrk_test', capabilities: ['fixture'] },
  }),
});
await client.ready();
```

Consumers branch on stable `ViceMeError.code` values only — never on error
messages. Work-session tokens and work-scoped users remain in memory only.
