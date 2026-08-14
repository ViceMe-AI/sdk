# Release & CDN Runbook

This is the operational runbook for releasing `@viceme-ai/sdk` and promoting
it to the CDN. The architecture is fixed in the SDK plan (§14); this document
only describes _how to run it_.

## Prerequisites (one-time, owner permissions)

- [ ] Final license confirmed; `LICENSE-PENDING.md` replaced by `LICENSE`
      (**publishing is blocked by policy until then**).
- [ ] GitHub environment `npm` with required reviewers.
- [ ] `@viceme-ai` npm scope configured for OIDC trusted publishing
      (repository `ViceMe-AI/sdk`, workflows `release-package.yml`,
      environment `npm`). No long-lived npm tokens.
- [ ] CDN buckets for `cdn.viceme.cn` and `cdn.viceme.ai`, plus the
      `CDN_UPLOAD_COMMAND` secret implementing the upload contract
      (`upload <local-file> <object-key>`), enforcing
      `cache-control: public, max-age=31536000, immutable`, correct
      content-types, and `access-control-allow-origin: *` for js/json objects.

## Releasing an npm version (0.x uses the `next` dist-tag)

1. Merge feature PRs; each carries its Changeset.
2. The **Release Package** workflow opens a `Version Packages` PR when
   changesets are pending. Review it (version bumps + changelog only).
3. Merge the Version PR. The workflow reruns the full quality gate, publishes
   to npm with provenance, and attaches the CDN artifacts to the GitHub
   release tag `@viceme-ai/sdk@<version>`.
4. Nothing about the CDN changes yet.

> 0.x phase: keep releases on the `next` dist-tag (`pnpm release:publish`
> follows the Changeset pre-release mode when `.changeset/pre.json` exists).

## Promoting a version to the CDN

1. Run the **Promote CDN** workflow with the exact released `version`.
2. It downloads the GitHub release artifacts, re-verifies every digest
   locally, uploads immutable objects to `/sdk/<version>/**`, and verifies
   them from the public network (sha256/SRI/bytes/content-type/cache headers)
   per region.
3. Leave `moveStableAlias` off unless the release is meant to become the
   stable major. With it on, the workflow additionally:
   - rewrites `/sdk/v1/**` to the verified version,
   - verifies the alias from the public network (`--expect-version`),
   - runs a real-network loader smoke test.

**Exact versions are immutable. Never re-upload or overwrite
`/sdk/<version>/**` for an existing version.**

## Rollback

Rollback never deletes or rewrites an exact version; it only moves the stable
alias:

1. Pick the previous verified version (see release history; every promoted
   version has passed read-back).
2. Re-run **Promote CDN** with that `version` and `moveStableAlias=true`.
3. The alias verification step fails loudly if the read-back does not match.

npm versions are never unpublished or reused.

## Verification tooling

```bash
node scripts/verify-cdn.mjs --local packages/sdk/dist
node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/1.2.3/
node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/v1/ --expect-version 1.2.3 --allow-mutable-cache
```

The manifest digests are produced by `scripts/build-manifest.mjs` during the
release build; npm tarball and CDN objects always come from that one build.
