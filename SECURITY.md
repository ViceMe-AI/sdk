# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately — do **not** open a public
issue.

Contact: security@viceme.cn (replace with the confirmed security inbox before
the first stable release).

Include reproduction steps, affected versions, and impact. We will acknowledge
receipt within 5 business days.

## Scope

- All packages published from this repository (`@viceme-ai/sdk` and its
  subpaths).
- The CDN auto-loader and release artifacts published to `cdn.viceme.cn` /
  the GLOBAL CDN endpoint.

## Out of scope

- Vulnerabilities in unreleased branches without a realistic attack path.
- Reports requiring access to ViceMe internal systems, private Shop code, or
  real customer data.

## Rules for issues and PRs

- Never paste secrets, API keys, tokens, cookies, raw payment provider
  payloads, or complete payment data into issues, PRs, or test fixtures.
- Examples must use fictional work keys (`wrk_public_example`) and mock
  endpoints only.
