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

## Releasing an npm version (0.x → `next` dist-tag)

The 0.x phase publishes under `next` only, enforced in three places:

1. `.changeset/pre.json` puts Changesets in pre-release mode with tag `next`.
2. `release-package.yml` sets `DIST_TAG: next` and `pnpm release:publish`
   passes `--tag "$DIST_TAG"` to `pnpm publish`.
3. A post-publish step runs
   `node scripts/verify-npm-dist-tag.mjs --tag next --version <v>` and fails
   if the live registry shows anything else (or `latest` pointing at it).

Flow:

1. Merge feature PRs; each carries its Changeset.
2. The **Release Package** workflow opens a `Version Packages` PR when
   changesets are pending. Review it (version bumps + changelog only).
3. Merge the Version PR. The workflow reruns the full quality gate, runs the
   release gate, publishes with provenance under `next`, verifies the npm
   dist-tag read-back, and attaches the CDN artifacts to the GitHub release
   tag `@viceme-ai/sdk@<version>` (create-if-absent; identical bytes are
   idempotent; differing bytes fail — release assets are immutable).
4. Nothing about the CDN changes yet.

At `1.0.0`: remove `.changeset/pre.json` (exit pre mode), set `DIST_TAG:
latest` in the workflow, both in the same release PR (§14.1).

## Promoting a version to the CDN

Run the **Promote CDN** workflow with the exact released `version` (and the
target `regions`, validated as `cn`/`global`):

1. Downloads the GitHub release artifacts and re-verifies every digest
   locally.
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
With `moveStableAlias=true`, the workflow writes that single pointer object
per region (an atomic object write — no per-file copying, no torn state),
verifies the pointer read-back equals the version, and verifies the alias
resolves with `verify-cdn.mjs --expect-version`. Until the edge implements
pointer resolution, this step fails closed by design.

**Rollback** = re-run Promote CDN with the previous verified version and
`moveStableAlias=true`: only the pointer moves. Exact-version objects are
never rewritten or deleted; npm versions are never unpublished or reused.

## Post-publish failure recovery

If npm publish succeeded but a later step failed (dist-tag verification,
GitHub release assets), re-running the **Release Package** workflow will NOT
retry those steps — Changesets already sees the version as released. The
convergent recovery is the **Release Assets (recovery)** workflow:

1. Run it with the published `version`.
2. It proves the version is live (npm dist-tag read-back), downloads the
   published npm tarball (assets are byte-identical to what npm serves),
   verifies digests, and attaches to the GitHub release idempotently
   (create-if-absent / identical-skip / differ-fail).
3. Re-run as many times as needed; it always converges.

Drill (rehearse after the first real release): delete the
`dist-<version>.zip` asset from the release, re-run the recovery workflow,
and confirm it restores the byte-identical asset. `node
scripts/attach-release-assets.mjs --version <v> --dry-run` stages and
digest-verifies assets without any GitHub API calls.

## Verification tooling

```bash
pnpm release:gate        # license + package metadata preconditions
node scripts/verify-cdn.mjs --local packages/sdk/dist
node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/1.2.3/
node scripts/verify-cdn.mjs --base https://cdn.viceme.cn/sdk/v1/ --expect-version 1.2.3 --allow-mutable-cache
node scripts/upload-plan.mjs --dist packages/sdk/dist --base https://cdn.viceme.cn/sdk/1.2.3/
node scripts/write-alias-pointer.mjs --version 1.2.3 --regions cn --hosts cn=... --upload-command "..."
node scripts/attach-release-assets.mjs --version 1.2.3 --dry-run
node scripts/verify-npm-dist-tag.mjs --version 1.2.3 --tag next
```

Manifest digests come from `scripts/build-manifest.mjs` during the release
build; the npm tarball and CDN objects always originate from that one build.
The plan always includes `manifest.json` itself as a first-class immutable
object (an empty CDN must receive it before `verify-cdn` can read it).
