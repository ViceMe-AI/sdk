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

const access = await client.access.checkMany(['dingdong', 'emperor']);
if (access.dingdong.allowed) enableDingdong();
if (access.emperor.allowed) enableEmperor();

// Call from a user gesture. A denied decision opens the ViceMe
// bottom-sheet/in-page Web Component. Follow consent appears after sign-in in
// the same layer, and only accepting it follows the creator.
const decision = await client.access.require('emperor');
if (decision.allowed) enableEmperor();

client.destroy();
```

The SDK registers and mounts `<viceme-access-layer>` with isolated ViceMe-owned
styles. Authorization and checkout remain inside its iframe area and complete through
an origin- and channel-validated message; no browser popup, page navigation,
`confirm`, or `alert` is used. Custom site presenters and style inference are
not part of the current public contract.

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
