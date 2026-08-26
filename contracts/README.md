# Public API Contract Snapshots

This directory holds machine-readable snapshots of the Shop public API
(`/v1/public/v1/**` and `/v1/danmaku/messages`) that the SDK compiles against.

## Authority

- The **Shop API** is the single authority for the HTTP contract. Shop builds
  export the public OpenAPI snapshot; internal Session, Admin, payment
  provider, and ops endpoints are never included.
- The SDK never hand-writes a second copy of the DTOs: TypeScript types are
  generated from the snapshot by `scripts/generate-contracts.mjs` into
  `packages/sdk/src/generated/public-contract.ts` (committed), and CI fails if
  regeneration drifts.

## Current state

`public-capabilities.openapi.json` documents the creator Work Session, login,
follow, access, checkout, and hosted danmaku endpoints consumed by the SDK and
Shop iframe. The manifest records its exact digest and provenance:

```json
{
  "contractVersion": "0.4.0",
  "sha256": "…",
  "generatedFrom": "ViceMe Shop public capabilities contract",
  "generatedAt": "…"
}
```

## Update flow

```text
Shop PR adds a backward-compatible API
  -> Shop generates the public contract artifact
  -> SDK "Contract Sync" PR replaces the snapshot + manifest
  -> pnpm contracts:generate && pnpm contracts:check
  -> SDK next release validates against real API
  -> stable SDK release
  -> Shop enables the capability
```

## Compatibility rules (§12.3)

| Change                                  | SDK version       |
| --------------------------------------- | ----------------- |
| Optional response fields added          | minor             |
| New endpoint / capability               | minor             |
| Docs or no-semantic-change fix          | patch             |
| Field removed / type or error semantics | major + API major |

- The SDK ignores unknown response fields but rejects missing required fields
  for the current contract version.
- A snapshot digest mismatch fails CI; the SDK never guesses at runtime.

## Commands

```bash
pnpm contracts:generate   # snapshot -> src/generated/public-contract.ts
pnpm contracts:check      # drift gate: committed file must match regeneration
```
