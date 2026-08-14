# Release & Delivery Runbook

Operational runbook for releasing `@viceme-ai/sdk` and delivering it to the
dual-region S3 topology. Architecture is fixed in the SDK plan (§14); this
documents _how to run it_.

## Prerequisites (one-time, owner permissions)

- [ ] Final license confirmed; `LICENSE-PENDING.md` replaced by `LICENSE`
      at the repo root. The build copies it into `packages/sdk/LICENSE`
      (gitignored) so the tarball ships it; `pnpm release:gate` and the
      tarball audit both block publishing until then.
- [ ] GitHub environments `npm` (publication) and `cdn` (S3 writes), each
      with required reviewers.
- [ ] `@viceme-ai` npm scope configured for OIDC trusted publishing
      (repository `ViceMe-AI/sdk`, workflow `release-package.yml`,
      environment `npm`). No long-lived npm tokens.
- [ ] Release App (`RELEASE_APP_ID` var + `RELEASE_APP_PRIVATE_KEY` secret)
      so the Version Packages PR chain triggers required checks.
- [ ] Dual-region S3 secrets (names are fixed): `VICEME_RELEASE_S3_
{ENDPOINT,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}_{CN,GLOBAL}` plus
      `CN_S3_HTTPS_PROXY`. Each region's bucket is the dedicated
      `viceme-sdk` bucket (never shared with Shop skill ZIPs, media, or
      installer assets); credentials must be scoped to that bucket.
- [ ] Feishu/AI secrets: `FEISHU_BOT_WEBHOOK`, `FEISHU_RELEASE_WEBHOOK`,
      `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` (no defaults — the release
      notification fails closed when any is missing).

## Public delivery topology

The current public entries are the S3 path-style hosts:

```text
https://s3.viceme.cn/viceme-sdk/<version>/...   (region cn)
https://s3.viceme.ai/viceme-sdk/<version>/...   (region global)
```

`/viceme-sdk/v1` is an alias, NOT a copy of a version: it carries the loader
object plus a single version pointer at `viceme-sdk/-/aliases/v1` (the one
mutable object). The loader resolves the pointer at runtime (see
`resolveAliasPointer` in `packages/sdk/src/loader/auto-loader.ts`), so
moving the alias is one atomic pointer write per region. If a CDN edge
(`cdn.viceme.cn` / `cdn.viceme.ai`) is introduced later, keep these exact
paths and add edge caching in front — the URL contract must not change.

## Releasing an npm version (0.x -> `next` dist-tag)

The Release Package workflow is the single authoritative state machine
(all steps bind to the reviewed Version Packages PR merge SHA):

1. **Version PR**: Changesets opens/updates the **Version Packages** PR via
   the Release App token (branches pushed by `GITHUB_TOKEN` would not
   trigger the required pull_request checks).
2. **Identity**: on merge, `resolve-release-context.mjs` binds the run to
   that exact merge commit; the immutable annotated tag
   `@viceme-ai/sdk@<version>` is created only after all fail-closed gates
   (license gate, forbidden-pattern scan, full quality gate) pass at that
   SHA.
3. **npm**: pinned OIDC-capable npm CLI (`npm@11.12.1`), verified OIDC
   context, `publish-or-verify.mjs` — no tokens anywhere. Convergent:
   already published with matching integrity = success; different
   integrity = fail; not published = `npm publish --provenance`. The
   `next` dist-tag moves forward only; `latest` must never point at a
   `next` release (flip the workflow-level `DIST_TAG` to `latest` at
   1.0.0, same PR that exits `.changeset/pre.json` pre mode).
4. **GitHub assets**: release assets are attached from the published npm
   tarball (`fetch-npm-dist.mjs` + `attach-release-assets.mjs`),
   idempotent and immutable.
5. **CN + GLOBAL S3** (`environment: cdn`): the same npm-tarball bytes are
   published to both `viceme-sdk` buckets with immutable-put semantics
   (absent -> upload with immutable headers; identical -> skip; different
   -> fail closed; `head-bucket` first; CN calls egress through
   `CN_S3_HTTPS_PROXY`), then verified from the public S3 entries.
6. **Notification**: the Feishu release summary fires only after npm AND
   both S3 regions succeeded; AI changelog settings must be fully
   configured or the job fails closed.

A release is DONE only when step 6 has run. Exact-version artifacts are
never left as a manual follow-up.

## Recovery

Re-run the Release Package workflow with the `tag` input
(`@viceme-ai/sdk@<version>`): recovery reuses the immutable tag/SHA and
re-runs every step convergently — npm (integrity match), GitHub assets
(idempotent), and both S3 regions (immutable-put semantics). For
asset-only repair on ANY historical version, the **Release Assets
(recovery)** workflow requires only that the exact version exists on npm.

Drill: delete the `dist-<version>.zip` release asset, re-run recovery, and
confirm the byte-identical asset is restored (`attach-release-assets.mjs
--dry-run` stages and digest-verifies without GitHub API calls).

## Moving the stable alias (`/viceme-sdk/v1`)

The **Promote CDN** workflow only manages the alias pointer (exact-version
delivery is automatic in Release Package):

- `aliasAction=promote` (default): forward-only move. The live pointer is
  read first and the shared policy refuses backward or same-version moves,
  so a stale rerun can never roll the alias back.
- `aliasAction=rollback` + `aliasExpectedCurrent=<exact current version>`:
  the only path allowed to move backward. The live pointer must equal the
  declared value (stale/concurrent guard) and the target must be older.

Mechanics per region (credentials via the fixed S3 secret names, dedicated
`viceme-sdk` bucket, CN through its HTTPS proxy): the content-stable
loader object is placed at `viceme-sdk/v1/viceme.min.js` with immutable-put
semantics, then the single pointer object `viceme-sdk/-/aliases/v1` is written
(`text/plain`, short TTL) and the public URL is polled until it matches.
The loader itself resolves `/viceme-sdk/v1` by reading the pointer at runtime, so
even a torn write stays functional. Reads are origin-fresh on the S3
entries (no edge cache yet); when a CDN edge is introduced, add edge
caching without changing the URL contract.

## Verification tooling

```bash
pnpm release:gate        # license + package metadata preconditions
node scripts/validate-release-inputs.mjs --version 1.2.3 --regions cn,global
node scripts/verify-cdn.mjs --local packages/sdk/dist
node scripts/verify-cdn.mjs --base https://s3.viceme.cn/viceme-sdk/1.2.3/
node scripts/verify-cdn.mjs --base https://s3.viceme.cn/viceme-sdk/v1/ --expect-version 1.2.3
node scripts/fetch-npm-dist.mjs --version 1.2.3 --out verified-dist
node scripts/attach-release-assets.mjs --version 1.2.3 --dry-run
node scripts/verify-npm-dist-tag.mjs --version 1.2.3 --tag next
```

Manifest digests come from `scripts/build-manifest.mjs` during the release
build; the npm tarball, GitHub assets, and both S3 regions all originate
from that one build, and every region upload includes `manifest.json`
itself as a first-class immutable object.
