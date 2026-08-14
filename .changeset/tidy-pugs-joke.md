---
'@viceme-ai/sdk': patch
---

B0.2 (SDK side): public contract snapshot pipeline — `contracts/` baseline OpenAPI snapshot + manifest, generated TS types (`src/generated/public-contract.ts`) with CI drift gate, session DTOs now typed from the snapshot, and real-HTTP transport compatibility tests (timeout, caller abort, request ids, status/error normalization, unknown-field tolerance, fail-closed malformed responses).
