# Release & Delivery Runbook

Operational runbook for releasing `@viceme-ai/sdk` and delivering it to the
dual-region S3 topology. Architecture is fixed in the SDK plan (§14); this
documents _how to run it_.

## Prerequisites (one-time, owner permissions)

- [ ] GitHub environment `cdn` exists for S3 publication.
- [ ] npm Trusted Publisher is configured exactly like the CLI release:
      repository `ViceMe-AI/sdk`, workflow `release.yml`, with no GitHub
      Environment restriction. The package bootstrap has completed; normal
      releases are OIDC-only and must not expose an `NPM_TOKEN` or
      `NODE_AUTH_TOKEN` to the workflow.
- [ ] Release App (`RELEASE_APP_ID` var + `RELEASE_APP_PRIVATE_KEY` secret)
      installed with repository Contents write access. It commits generated
      version and changelog files to protected `dev`; PR updates use the
      workflow `GITHUB_TOKEN` and do not require Pull requests permission on
      the App.
- [ ] Dual-region S3 secrets (names are fixed): `VICEME_RELEASE_S3_
{ENDPOINT,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}_{CN,GLOBAL}` plus
      `CN_S3_HTTPS_PROXY`. Each region's bucket is the dedicated
      `viceme-sdk` bucket (never shared with Shop skill ZIPs, media, or
      installer assets); credentials must be scoped to that bucket.
- [ ] Feishu/AI secrets: `FEISHU_BOT_WEBHOOK`, `FEISHU_RELEASE_WEBHOOK`, and
      `AI_API_KEY`. `AI_MODEL` and `AI_BASE_URL` are optional overrides; like
      the CLI release, they default to `deepseek-chat` and
      `https://api.deepseek.com/v1`.

## Public delivery topology

The current public entries are the S3 path-style hosts:

```text
https://s3.viceme.cn/viceme-sdk/<version>/...   (region cn)
https://s3.viceme.ai/viceme-sdk/<version>/...   (region global)
```

On the direct S3 hosts, `/viceme-sdk/v1` is an alias, NOT a copy of a version:
its fixed bootstrap reads the single version pointer at
`viceme-sdk/-/aliases/v1`, then injects the exact-version full loader. The
public Shop route `https://viceme.cn/viceme-sdk/v1/*` is different: it proxies
the complete artifact set from one configured exact release and never follows
the S3 pointer at request time. If a CDN edge
(`cdn.viceme.cn` / `cdn.viceme.ai`) is introduced later, keep these exact
paths and add edge caching in front — the URL contract must not change.

## Releasing a stable npm version

The release flow follows the same two-workflow state machine as the CLI:

`0.1.6` is the already-used baseline for this development cycle. Feature
branches intentionally leave it unchanged; the release preparation workflow
must atomically advance the package, runtime, and changelog to `0.2.0` before
the `dev -> main` promotion. Its existing comparison against the version on
`main` fails closed if a normal publication attempts to reuse `0.1.6`.

1. **Release preparation PR**: open the reviewed `dev -> main` PR. The
   `release-pr.yml` workflow uses the same stable-version algorithm as the CLI:
   Conventional Commits since the latest reachable release tag select major,
   minor, or patch; the workflow then generates the package version, runtime
   version, and changelog. It runs the full SDK quality gate and uses the
   Release App (Contents write only) to commit those generated files back to
   protected `dev`. It then
   uses `GITHUB_TOKEN` to update the same PR title and body. No additional
   Version Packages PR is created.
2. **Identity**: after that PR is merged, `release.yml` and
   `resolve-release-context.mjs` bind the run to the exact reviewed `dev` head
   recorded by the merged promotion PR (not the generated merge commit); the
   immutable annotated tag
   `@viceme-ai/sdk@<version>` is created only after the release-specific
   forbidden-pattern scan and full quality gate pass at that SHA.
3. **npm**: pinned OIDC-capable npm CLI (`npm@11.12.1`), verified OIDC
   context, and token-free `publish-or-verify.mjs`, matching the CLI.
   Convergent:
   already published with matching integrity = success; different
   integrity = fail; not published = `npm publish --provenance`. The
   stable `latest` dist-tag moves forward only. SDK releases never generate
   prerelease package versions such as `-next.N`.
4. **GitHub assets**: release assets are attached from the published npm
   tarball (`fetch-npm-dist.mjs` + `attach-release-assets.mjs`),
   idempotent and immutable.
5. **CN + GLOBAL S3** (`environment: cdn`): the same npm-tarball bytes are
   published to both `viceme-sdk` buckets with immutable-put semantics
   (absent -> upload with immutable headers; identical -> skip; different
   -> fail closed; `head-bucket` first; CN calls egress through
   `CN_S3_HTTPS_PROXY`), then verified from the public S3 entries.
6. **Notification**: the Feishu release summary fires only after npm AND
   both S3 regions succeeded. The webhook and AI API key are required; model
   and base URL use the same defaults as the CLI unless explicitly overridden.
   The card presents `viceme-sdk v<version>` like the CLI; the scoped npm tag
   remains an internal release and recovery identity rather than display text.

A release is DONE only when step 6 has run. Exact-version artifacts are
never left as a manual follow-up.

## Recovery

Re-run the **SDK release publication** workflow (`release.yml`) with the
`tag` input (`@viceme-ai/sdk@<version>`): recovery reuses the immutable tag/SHA and
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
`viceme-sdk` bucket, CN through its HTTPS proxy):

1. `v1/viceme.min.js` carries the **fixed bootstrap** (canonical bytes:
   `<version>/bootstrap.min.js` from this release build). The bootstrap is
   byte-stable for the whole API major — it only reads the pointer and
   injects `<version>/viceme.min.js` (the full loader, which may change
   every release). `v1/viceme.min.js` is an alias object like the pointer:
   re-written on every promote and verified by an exact public byte
   read-back against the canonical build, so it can never be locked to one
   release's bytes nor serve corrupted content silently.
2. The single pointer object `-/aliases/v1` is written (`text/plain`,
   short TTL) and polled until the public read matches.
3. `verify-cdn --expect-version` byte-verifies the alias loader against
   the pointed version's bootstrap in addition to the full exact-version
   verification; the workflow smoke covers both regions.

Reads are origin-fresh on the S3 entries (no edge cache yet); when a CDN
edge is introduced, add edge caching without changing the URL contract.

## Verification tooling

```bash
node scripts/validate-release-inputs.mjs --version 1.2.3 --regions cn,global
node scripts/verify-cdn.mjs --local packages/sdk/dist
node scripts/verify-cdn.mjs --base https://s3.viceme.cn/viceme-sdk/1.2.3/
node scripts/verify-cdn.mjs --base https://s3.viceme.cn/viceme-sdk/v1/ --expect-version 1.2.3
node scripts/fetch-npm-dist.mjs --version 1.2.3 --out verified-dist
node scripts/attach-release-assets.mjs --version 1.2.3 --dry-run
node scripts/verify-npm-dist-tag.mjs --version 1.2.3 --tag latest
```

Manifest digests come from `scripts/build-manifest.mjs` during the release
build; the npm tarball, GitHub assets, and both S3 regions all originate
from that one build, and every region upload includes `manifest.json`
itself as a first-class immutable object.
