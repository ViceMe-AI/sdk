# Public API Contract Snapshots

This directory holds the machine-readable snapshot of the Shop public danmaku
API (`/v1/danmaku/messages`).

## Authority

- The **Shop API** is the single authority for the HTTP contract. Session,
  authentication, follow, access, checkout, payment-provider, Admin, and ops
  endpoints are not part of this snapshot.
- TypeScript reference types are generated from the snapshot by
  `scripts/generate-contracts.mjs` into
  `packages/sdk/src/generated/public-contract.ts` (committed), and CI fails if
  regeneration drifts.
- The external SDK does not call this endpoint. It mounts Shop's hosted
  `/embed/danmaku` iframe; the Shop SDK inside that frame calls the API.

## Current state

`public-capabilities.openapi.json` contains only anonymous message reads and
writes for published Works whose active `WorkSdkAccess` includes `danmaku`.
There is no SDK Work Session or generic browser Bearer token.

The manifest records snapshot provenance:

```json
{
  "contractVersion": "1.0.0",
  "sha256": "…",
  "generatedFrom": "ViceMe Shop public danmaku contract",
  "generatedAt": "…"
}
```

## Update flow

```text
Shop changes the public danmaku API
  -> Shop updates the public contract artifact
  -> SDK "Contract Sync" PR replaces the snapshot + manifest
  -> pnpm contracts:generate && pnpm contracts:check
  -> SDK validates its hosted-runtime boundary
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

- The SDK ignores unknown response fields but rejects missing required fields
  for the current contract version.
- A snapshot digest mismatch fails CI; the SDK never guesses at runtime.
- The loader API major changes only when its public HTML attributes, global
  namespace, or hosted mount semantics become incompatible. This snapshot is
  not the loader namespace: its `1.0.0` reset removes APIs the external SDK no
  longer calls while loader `v1` remains backward-compatible for danmaku.

## Commands

```bash
pnpm contracts:generate   # snapshot -> src/generated/public-contract.ts
pnpm contracts:check      # drift gate: committed file must match regeneration
```
