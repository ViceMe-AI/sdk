#!/usr/bin/env bash
# Run the pinned actionlint against all workflows (local helper; CI runs
# the same digest-pinned binary inline in quality-gate.yml).
set -euo pipefail

VERSION='1.7.7'
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) TARGET='darwin_arm64'; SHA='2693315b9093aeacb4ebd91a993fea54fc215057bf0da2659056b4bc033873db' ;;
  Darwin/amd64) TARGET='darwin_amd64'; SHA='28e5de5a05fc558474f638323d736d822fff183d2d492f0aecb2b73cc44584f5' ;;
  Linux/x86_64) TARGET='linux_amd64'; SHA='023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757' ;;
  Linux/aarch64) TARGET='linux_arm64'; SHA='401942f9c24ed71e4fe71b76c7d638f66d8633575c4016efd2977ce7c28317d0' ;;
  *) echo "unsupported platform for actionlint" >&2; exit 1 ;;
esac

CACHE_DIR="${TMPDIR:-/tmp}/viceme-actionlint-${VERSION}"
BIN="${CACHE_DIR}/actionlint"
if [ ! -x "${BIN}" ]; then
  mkdir -p "${CACHE_DIR}"
  TARBALL="$(mktemp)"
  curl -fsSL -o "${TARBALL}" \
    "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_${TARGET}.tar.gz"
  echo "${SHA}  ${TARBALL}" | shasum -a 256 --check
  tar -xzf "${TARBALL}" -C "${CACHE_DIR}" actionlint
  rm -f "${TARBALL}"
fi
exec "${BIN}" -color -shellcheck= -pyflakes= "$@"
