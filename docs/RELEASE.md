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

Each static loader, manifest, ESM entry, and chunk is consumed from one of those
exact-version directories. If a CDN edge (`cdn.viceme.cn` / `cdn.viceme.ai`) is
introduced later, keep the exact-version path contract and add edge caching in
front.

## Releasing a stable npm version

The release flow follows the same two-workflow state machine as the CLI:

`0.4.0` is the immutable published baseline for this development cycle. It
contains Website Access v2, the generic testing adapter, mounted Danmaku, and
mounted Tip, but not Headless `createTip` or `tip/testing`. Feature branches
intentionally keep package and runtime versions at `0.4.0`; they must never
republish or retrofit that artifact.

The `0.5.0` promotion metadata reached `main`, but publication stopped at the
license gate before the immutable tag was created. Treat `0.5.0` as reserved
and unpublished; never create its tag retroactively. Once the final license is
approved, the next release preparation uses protected `main` at `0.5.0` as its
baseline and advances the current additive changes to `0.6.0`. Loader API major
`v1` remains compatible, while the public HTTP snapshot uses its own `1.1.0`
contract version.

The current tree still contains `LICENSE-PENDING.md` and no approved root
`LICENSE`. `assert-release-license.mjs`, package prepublish, npm artifact
recovery, and S3 publication therefore fail closed for `0.5.0`. The historical
`0.4.0` artifact predates that gate and remains immutable; do not add or replace
files under the same npm or CN/GLOBAL exact version.

1. **Release preparation PR**: open the reviewed `dev -> main` PR. The
   `release-pr.yml` workflow selects the higher versioned baseline from the
   latest stable tag and protected `main`. This preserves immutable tag
   provenance while allowing a failed publication to reserve a version on
   `main`. Conventional Commits after that baseline select major, minor, or
   patch; the workflow then generates the package version, runtime version, and
   changelog. It runs the full SDK quality gate and uses the
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

## Verification tooling

```bash
node scripts/validate-release-inputs.mjs --version 1.2.3 --regions cn,global
node scripts/verify-cdn.mjs --local packages/sdk/dist
node scripts/verify-cdn.mjs --base https://s3.viceme.cn/viceme-sdk/1.2.3/ --expect-version 1.2.3
node scripts/fetch-npm-dist.mjs --version 1.2.3 --out verified-dist
node scripts/attach-release-assets.mjs --version 1.2.3 --dry-run
node scripts/verify-npm-dist-tag.mjs --version 1.2.3 --tag latest
```

Manifest digests come from `scripts/build-manifest.mjs` during the release
build; the npm tarball, GitHub assets, and both S3 regions all originate
from that one build, and every region upload includes `manifest.json`
itself as a first-class immutable object.
