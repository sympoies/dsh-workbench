#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ "${1:-}" == preflight || "${1:-}" == publish ]]; then
  exec node "$repo_root/scripts/release-publish.mjs" "$@"
fi
exec node "$repo_root/scripts/release.mjs" "$@"
