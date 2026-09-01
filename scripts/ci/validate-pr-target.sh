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

  printf 'pull request target contract tests passed\n'
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
else
  validate_pr_target \
    "${GITHUB_EVENT_NAME:-}" \
    "${PR_BASE_REF:-}" \
    "${PR_HEAD_REF:-}" \
    "${PR_HEAD_REPOSITORY:-}" \
    "${GITHUB_REPOSITORY:-}"
fi
