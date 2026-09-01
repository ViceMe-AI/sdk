# Contributing to the ViceMe SDK

## Prerequisites

- Node.js >= 20
- pnpm >= 10 (`corepack enable`)

## Setup

```bash
pnpm install
pnpm exec playwright install chromium firefox webkit
```

## Commands

```bash
pnpm build         # clean -> ESM -> loader -> types -> manifest (fixed order)
pnpm lint          # eslint
pnpm format        # prettier --write
pnpm format:check  # prettier --check
pnpm typecheck     # tsc --noEmit for packages
pnpm test          # vitest unit tests
pnpm test:browser  # Playwright tests (local dist + mocked hosted iframe)
pnpm pack:check    # tarball content audit + import smoke from the real tarball
pnpm contracts:generate # snapshot -> generated TS types + contract manifest
pnpm contracts:check   # drift gate: committed types/manifest must match snapshot
pnpm check         # everything above, in CI order
```

`pnpm test:browser` runs the full Chromium/Firefox/WebKit matrix, matching the
CI quality gate. If a browser cannot launch on your machine (e.g. Firefox
headless graphics issues on some macOS versions), run a subset locally — CI
still covers the full matrix:

```bash
pnpm --filter '@viceme-ai/sdk' exec playwright test --project=chromium
```

Docker, CDN uploads, and npm publishing are **not** package scripts; they are
explicit GitHub Actions workflows.

## Architecture rules (fixed baseline)

These decisions are already made; PRs must not reopen them:

1. `@viceme-ai/sdk` is the only published package in the `0.x` phase.
2. Capabilities ship as subpath exports (`@viceme-ai/sdk/<capability>`); a
   subpath may not exist until the capability is real.
3. Pure HTML/JavaScript is a first-class delivery path. React is an optional
   thin binding over the same local core.
4. Dependency direction:

   ```text
   local Work config -> hosted danmaku mount -> CDN loader or framework binding
     -> Shop-hosted iframe -> Shop SDK -> /v1/danmaku/messages
   ```

   Lower layers must never import the loader, React, or host code. The headless
   core does not touch the DOM.

5. The production `createViceMe()` config accepts only `workKey` and `region`.
   It is purely local; test transports and SDK Sessions do not exist.
6. Visible components mount inside an open Shadow Root; `destroy()` must remove
   listeners, observers, timers, and DOM nodes.

## Capability module template

The released danmaku directory provides:

```text
packages/sdk/src/<capability>/
├── index.ts      public entry, stable API only
├── mount.ts      optional UI mount/destroy
└── anchor.ts     opaque page-position anchor derivation
```

## PR checklist

- [ ] User scenario and explicit non-goals
- [ ] Public API / subpath and release impact
- [ ] Shop API contract version referenced
- [ ] Work identity, iframe Origin, and secret boundaries stated
- [ ] Browser lifecycle and resource cleanup tested
- [ ] Static HTML / React / Next.js usage examples updated
- [ ] Bundle size delta justified (`pnpm --filter '@viceme-ai/sdk' build` then
      check `dist/manifest.json`)
- [ ] Mock, real-browser, and real-backend tests where applicable
- [ ] Failure degradation and retry strategy documented
- [ ] No private Shop code, internal hostnames, secrets, or real user data
- [ ] `pnpm check` passes locally

## Releases

Releases use the same Conventional Commit version policy and protected
`dev -> main` promotion flow as the ViceMe CLI, followed by npm trusted
publishing (OIDC). CDN artifacts always come from the same release build as
the npm tarball and are published only under immutable exact-version paths.
See `.github/workflows/`.
