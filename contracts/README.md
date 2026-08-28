# Public API Contract Snapshots

This directory holds the machine-readable snapshot of Shop's public danmaku API
and credential-free Tip configuration API.

## Authority

- The **Shop API** is the single authority for the HTTP contract. Session,
  authentication, follow, access, orders, payment actions, Admin, and ops
  endpoints are not part of this snapshot.
- TypeScript reference types are generated from the snapshot by
  `scripts/generate-contracts.mjs` into
  `packages/sdk/src/generated/public-contract.ts` (committed), and CI fails if
  regeneration drifts.
- The external SDK calls only Tip config. It mounts Shop's hosted
  `/embed/danmaku` iframe; the Shop SDK inside that frame calls the message API.

## Current state

`public-capabilities.openapi.json` contains anonymous message reads/writes and
`GET /v1/work-sdk/{workKey}/tip-config`. Tip config contains no order, token,
payment action, or provider transaction data. There is no SDK Work Session or
generic browser Bearer token.

The manifest records snapshot provenance:

```json
{
  "contractVersion": "1.1.0",
  "sha256": "…",
  "generatedFrom": "ViceMe Shop public danmaku contract",
  "generatedAt": "…"
}
```

## Update flow

```text
Shop changes a public capability API
  -> Shop updates the public contract artifact
  -> SDK "Contract Sync" PR replaces the snapshot + manifest
  -> pnpm contracts:generate && pnpm contracts:check
  -> SDK validates its hosted and Headless boundaries
  -> stable SDK release
  -> Shop enables the capability
```

## Compatibility rules (§12.3)

| Change                                  | SDK version    |
| --------------------------------------- | -------------- |
| Optional response fields added          | minor          |
| New endpoint / hosted capability        | minor          |
| Docs or no-semantic-change fix          | patch          |
| Field removed / type or error semantics | contract major |

- The SDK strictly validates Tip config fields and rejects unknown or missing
  fields for the current contract version.
- A snapshot digest mismatch fails CI; the SDK never guesses at runtime.
- The loader API major changes only when its public HTML attributes, global
  namespace, or hosted mount semantics become incompatible. This snapshot is
  not the loader namespace. Tip is additive to the published `v1` surface:
  npm `0.3.0` never exported Tip or a Tip paid event, so no unsafe intermediate
  order-bearing message is a compatibility contract.

## Commands

```bash
pnpm contracts:generate   # snapshot -> src/generated/public-contract.ts
pnpm contracts:check      # drift gate: committed file must match regeneration
```
