# Release & CDN Runbook

Operational runbook for releasing `@viceme-ai/sdk` and promoting it to the
CDN. Architecture is fixed in the SDK plan (§14); this documents _how to run
it_.

## Prerequisites (one-time, owner permissions)

- [ ] Final license confirmed; `LICENSE-PENDING.md` replaced by `LICENSE`
      at the repo root. The build copies it into `packages/sdk/LICENSE`
      (gitignored) so the tarball ships it; `pnpm release:gate` and the
      tarball audit both block publishing until then.
- [ ] GitHub environment `npm` with required reviewers.
- [ ] `@viceme-ai` npm scope configured for OIDC trusted publishing
      (repository `ViceMe-AI/sdk`, workflow `release-package.yml`,
      environment `npm`). No long-lived npm tokens.
- [ ] CDN buckets for `cdn.viceme.cn` (region `cn`) and `cdn.viceme.ai`
      (region `global`), plus the `CDN_UPLOAD_COMMAND` secret implementing
      the contract below.
- [ ] CDN edge resolves `/sdk/v1/<file>` from the alias pointer (see
      "Stable alias model").

### `CDN_UPLOAD_COMMAND` contract

A one-line command (bash `-lc`) invoked as:

```text
upload <region> <local-file> <object-key>
```

- `<region>` is `cn` or `global` and MUST select that region's own bucket
  and credentials — regions never share a target implicitly.
- For `sdk/<version>/…` keys: content-type by extension,
  `cache-control: public, max-age=31536000, immutable`,
  `access-control-allow-origin: *`, and no overwrite of existing objects
  (bucket-side object-lock / deny-overwrite is ideal).
- For the pointer key `sdk/-/aliases/v1`: `text/plain`, short TTL
  (`max-age=300`), overwriting is expected — it is the one mutable object.

### Optional `CDN_PURGE_COMMAND` contract

```text
purge <region> <object-key>
```

When configured, the alias step runs it right after each pointer write so
the read-back observes origin state immediately. Without it, pointer and
alias verification converge within the pointer's cache TTL (bounded wait,
see "Stable alias model") — slower but still correct.

## Releasing an npm version (0.x → `next` dist-tag)

Publication follows the reviewed `ViceMe-AI/cli` OIDC baseline — **no npm
tokens anywhere**:

- Changesets only opens **Version Packages** PRs; it never publishes.
- On merge, the workflow resolves the version from `packages/sdk/
package.json`, binds it to an **immutable annotated tag**
  `@viceme-ai/sdk@<version>` at the exact reviewed SHA (recovery runs
  require the tag to exist and point at that SHA), reruns the full quality
  gate at that SHA, installs the pinned OIDC-capable npm CLI (`npm@11.12.1`),
  verifies the OIDC context, and publishes via
  `scripts/publish-or-verify.mjs`:
  - already published with matching integrity → dist-tag policy verified,
    success (convergent rerun);
  - already published with different integrity → fail (immutable);
  - not published → `npm publish --provenance` (OIDC trusted publishing).
- The 0.x dist-tag policy is enforced by the same script: `next` moves
  forward only (a stale rerun of an older release never pulls it back), and
  `latest` must never point at a `next` release (`.changeset/pre.json`
  keeps Changesets in pre-release mode; flip `DIST_TAG` to `latest` at
  `1.0.0` in the same release PR that exits pre mode — `DIST_TAG` is the
  single variable both publish and read-back read).
- CDN artifacts are then attached to the GitHub release from the published
  npm tarball (immutable, idempotent).

Release binding: the pipeline runs only for the merge commit of a reviewed
**Version Packages** PR (`scripts/resolve-release-context.mjs`); ordinary
feature/doc pushes resolve to skip and never touch tags or npm. All
fail-closed gates (license gate, forbidden-pattern scan, full quality gate)
run at the exact release SHA BEFORE the immutable tag or the registry is
written.

Flow:

1. Merge feature PRs; each carries its Changeset.
2. Review and merge the **Version Packages** PR.
3. The workflow runs the whole pipeline above and attaches CDN artifacts.
4. Nothing about the CDN changes yet.

## Recovery

- **Any step after a successful npm publish failed**: re-run the Release
  Package workflow with the `tag` input (`@viceme-ai/sdk@<version>`) —
  recovery mode reuses the immutable tag/SHA, skips the immediate
  dist-tag gate, and converges assets. For asset-only repair on ANY
  historical version, run the **Release Assets (recovery)** workflow (it
  only requires the exact version to exist on npm, not any dist-tag).
- Drill: delete the `dist-<version>.zip` release asset and re-run the
  recovery workflow; it must restore the byte-identical asset.
  `attach-release-assets.mjs --dry-run` stages and digest-verifies without
  GitHub API calls.

## Promoting a version to the CDN

Run the **Promote CDN** workflow with the exact released `version` (and the
target `regions`, validated as `cn`/`global`):

1. Downloads the GitHub release artifacts, verifies every digest locally,
   and forwards THOSE exact bytes to the upload job as a workflow artifact —
   the upload job re-verifies the same directory before any write and never
   re-downloads, so a swapped release asset can never reach the immutable
   CDN paths.
2. Per region: `scripts/upload-plan.mjs` probes each public target —
   missing ⇒ upload, byte-identical ⇒ skip, **different ⇒ fail closed**
   (exact versions are never overwritten) — then uploads exactly the planned
   files through the region-scoped upload contract, and re-reads everything
   from the public network (`verify-cdn.mjs`: sha256/SRI/bytes/content-type/
   immutable cache headers/CORS).
3. Leave `moveStableAlias` off unless the release is meant to become the
   stable major.

### Stable alias model (`/sdk/v1`)

`/sdk/v1` is **not** a copy of a version's files. Each region serves one
small public pointer object:

```text
GET https://<cdn-host>/sdk/-/aliases/v1   ->   "<version>"
```

The CDN edge resolves `/sdk/v1/<file>` to `/sdk/<pointer-version>/<file>`.
The pointer only moves **forward** during a normal promote
(`aliasAction=promote`); `write-alias-pointer.mjs` refuses backward or
same-version moves. The write is one atomic object per region, verified
**with bounded convergence**: the public pointer URL is cacheable (short
TTL), so an optional purge runs first (`CDN_PURGE_COMMAND`) and the pointer
is otherwise polled until the read matches, within a budget longer than the
TTL; the alias-level `verify-cdn --expect-version` check retries with the
same bounded budget. A timeout reports the last observed value,
distinguishing a stale edge from an origin problem. Until the edge
implements pointer resolution, this step fails closed by design.

**Rollback** is a separate, explicit operation: run Promote CDN with the
previous verified version, `aliasAction=rollback`, and
`aliasExpectedCurrent=<the exact version currently served>`. The live
pointer must equal that declared value (stale/concurrent-move guard) and
the target must be older; otherwise the run fails without writing. Exact-
version objects are never rewritten or deleted; npm versions are never
unpublished or reused.

## Verification tooling

```bash
pnpm release:gate        # license + package metadata preconditions
node scripts/validate-release-inputs.mjs --version 1.2.3 --regions cn,global
node scripts/verify-cdn.mjs --local packages/sdk/dist
node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/1.2.3/
node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/v1/ --expect-version 1.2.3 --allow-mutable-cache
node scripts/upload-plan.mjs --dist packages/sdk/dist --base https://cdn.viceme.cn/sdk/1.2.3/
node scripts/write-alias-pointer.mjs --version 1.2.3 --regions cn --hosts cn=... --upload-command "..." [--purge-command "..."]
node scripts/attach-release-assets.mjs --version 1.2.3 --dry-run
node scripts/verify-npm-dist-tag.mjs --version 1.2.3 --tag next
```

Manifest digests come from `scripts/build-manifest.mjs` during the release
build; the npm tarball and CDN objects always originate from that one build.
The plan always includes `manifest.json` itself as a first-class immutable
object (an empty CDN must receive it before `verify-cdn` can read it).
