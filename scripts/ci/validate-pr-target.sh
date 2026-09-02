#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'pull request target error: %s\n' "$1" >&2
  return 1
}

validate_pr_target() {
  local event_name="$1"
  local base_ref="$2"
  local head_ref="$3"
  local head_repository="$4"
  local repository="$5"

  [[ "$event_name" == "pull_request" ]] || return 0
  [[ "$base_ref" == "main" ]] || return 0

  if [[ "$head_repository" != "$repository" ]]; then
    fail "main only accepts same-repository dev or hotfix/* pull requests"
    return 1
  fi

  case "$head_ref" in
    dev | hotfix/*) return 0 ;;
    *) fail "main only accepts dev or hotfix/*; got $head_ref" ;;
  esac
}

is_release_promotion() {
  [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]] &&
    [[ "${PR_BASE_REF:-}" == "main" ]] &&
    [[ "${PR_HEAD_REF:-}" == "dev" ]] &&
    [[ "${PR_HEAD_REPOSITORY:-}" == "${GITHUB_REPOSITORY:-}" ]]
}

has_release_prepared_trailer() {
  local line

  while IFS= read -r line; do
    [[ "$line" == "ViceMe-Release-Prepared: true" ]] && return 0
  done <<<"${PR_HEAD_BODY:-}"

  return 1
}

is_prepared_release_commit() {
  [[ "${PR_HEAD_SUBJECT:-}" =~ ^chore\(release\):\ @viceme-ai/sdk@[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "${PR_HEAD_AUTHOR_EMAIL:-}" =~ ^[0-9]+\+viceme-release-bot\[bot\]@users\.noreply\.github\.com$ ]] || return 1
  has_release_prepared_trailer
}

is_prepared_release_head() {
  is_release_promotion && is_prepared_release_commit
}

should_run_full_checks() {
  if is_release_promotion && ! is_prepared_release_head; then
    printf 'false\n'
  else
    printf 'true\n'
  fi
}

self_test() {
  validate_pr_target push main feature/example "" example/repo
  validate_pr_target pull_request dev feature/example fork/repo example/repo
  validate_pr_target pull_request main dev example/repo example/repo
  validate_pr_target pull_request main hotfix/urgent-fix example/repo example/repo

  if validate_pr_target pull_request main feature/example example/repo example/repo 2>/dev/null; then
    fail "self-test expected a direct feature to main to be rejected"
  fi
  if validate_pr_target pull_request main dev fork/repo example/repo 2>/dev/null; then
    fail "self-test expected a fork-owned dev promotion to be rejected"
  fi

  GITHUB_EVENT_NAME=pull_request
  PR_BASE_REF=main
  PR_HEAD_REF=dev
  PR_HEAD_REPOSITORY=example/repo
  GITHUB_REPOSITORY=example/repo
  PR_HEAD_SUBJECT='feat(sdk): unprepared promotion head'
  PR_HEAD_BODY=''
  PR_HEAD_AUTHOR_EMAIL='maintainer@example.com'
  [[ "$(should_run_full_checks)" == "false" ]] || fail "self-test expected an unprepared promotion to defer full checks"

  PR_HEAD_SUBJECT='chore(release): @viceme-ai/sdk@1.2.3'
  PR_HEAD_BODY=$'Generated release files.\n\nViceMe-Release-Prepared: true\nViceMe-Release-Run: https://github.com/example/repo/actions/runs/123'
  PR_HEAD_AUTHOR_EMAIL='12345+viceme-release-bot[bot]@users.noreply.github.com'
  is_prepared_release_commit || fail "self-test expected the marked Release Bot commit to be prepared"
  is_prepared_release_head || fail "self-test expected the marked promotion head to be prepared"
  [[ "$(should_run_full_checks)" == "true" ]] || fail "self-test expected a prepared promotion to run full checks"

  PR_HEAD_AUTHOR_EMAIL='maintainer@example.com'
  if is_prepared_release_head; then
    fail "self-test expected a maintainer-authored marker to remain unprepared"
  fi

  PR_BASE_REF=dev
  PR_HEAD_REF='feat/example'
  [[ "$(should_run_full_checks)" == "true" ]] || fail "self-test expected a normal pull request to run full checks"

  printf 'pull request target contract tests passed\n'
}

case "${1:-}" in
  --self-test)
    self_test
    ;;
  --is-prepared-release-head)
    if is_prepared_release_head; then
      printf 'true\n'
    else
      printf 'false\n'
    fi
    ;;
  --is-prepared-release-commit)
    if is_prepared_release_commit; then
      printf 'true\n'
    else
      printf 'false\n'
    fi
    ;;
  --should-run-full-checks)
    should_run_full_checks
    ;;
  *)
    validate_pr_target \
      "${GITHUB_EVENT_NAME:-}" \
      "${PR_BASE_REF:-}" \
      "${PR_HEAD_REF:-}" \
      "${PR_HEAD_REPOSITORY:-}" \
      "${GITHUB_REPOSITORY:-}"
    ;;
esac
