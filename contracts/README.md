# Public API Contract Snapshots

This directory holds the machine-readable snapshot of the Shop public SDK APIs
for Website Work access, hosted danmaku, and credential-free Tip configuration.

## Authority

- The **Shop API** is the single authority for the HTTP contract. The snapshot
  contains anonymous danmaku, origin-bound Website Work access calls, and the
  credentialless Tip configuration read; payment-provider, order, Admin, and
  ops endpoints are not public SDK contracts.
- TypeScript reference types are generated from the snapshot by
  `scripts/generate-contracts.mjs` into
  `packages/sdk/src/generated/public-contract.ts` (committed), and CI fails if
  regeneration drifts.
- Danmaku remains hosted in Shop's `/embed/danmaku` iframe. Access calls use a
  short-lived Work token bound to the published Work and its verified Origin.
- Headless Tip calls only `GET /v1/work-sdk/{workKey}/tip-config`, without
  Cookie or Authorization. Shop's trusted frame owns all Tip write operations.

## Current state

`public-capabilities.openapi.json` contains anonymous message reads/writes plus
Work-session, follow, access-decision, feature-presentation, and hosted-checkout
entry points, together with the read-only Tip configuration endpoint. The Work
token is memory-only and is not a general user session; Tip config contains no
token, order, payment action, or provider transaction data.

The manifest records snapshot provenance:

```json
{
  "contractVersion": "1.1.0",
  "sha256": "…",
  "generatedFrom": "ViceMe Shop public SDK contract",
  "generatedAt": "…"
}
```

## Update flow

```text
Shop changes a public SDK API
  -> Shop updates the public contract artifact
  -> SDK "Contract Sync" PR replaces the snapshot + manifest
  -> pnpm contracts:generate && pnpm contracts:check
  -> SDK validates its hosted, origin-bound, and Headless runtime boundaries
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
- Website Access keeps its existing response compatibility behavior; merging
  Tip does not narrow or replace those endpoints.
- A snapshot digest mismatch fails CI; the SDK never guesses at runtime.
- The loader API major changes only when its public HTML attributes, global
  namespace, or hosted mount semantics become incompatible. This snapshot is
  not the loader namespace. Tip is additive to the published `v1` surface:
  npm `0.4.0` exported mounted Tip but not `createTip` or `tip/testing`;
  Headless is therefore an additive `0.5.0` public capability.

## Commands

```bash
pnpm contracts:generate   # snapshot -> src/generated/public-contract.ts
pnpm contracts:check      # drift gate: committed file must match regeneration
```
