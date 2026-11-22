#!/usr/bin/env bash
# Host-wide safe local-CI launcher for both legacy and parallel-aware worktrees.
# Install this beside ci-lock.sh and use: agentes-ci-parallel /path/to/worktree
# This launcher is not a third scheduler. It is a synchronous lock-aware runner.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "usage: agentes-ci-parallel /absolute/path/to/AC/worktree" >&2
  exit 2
fi
requested="$1"
repo=$(cd "$requested" && pwd -P) || exit 2
if [ ! -f "$repo/scripts/ci-local.sh" ] || [ ! -f "$repo/scripts/ci-lock.sh" ]; then
  echo "ci parallel: not an AC checkout with the native CI scripts: $repo" >&2
  exit 2
fi
root=$(git -C "$repo" rev-parse --show-toplevel) || exit 2
[ "$root" = "$repo" ] || { echo "ci parallel: exact repository root required" >&2; exit 2; }
command -v bun >/dev/null || { echo "ci parallel: Bun is unavailable" >&2; exit 2; }
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "ci parallel: worktree has changes; CI is not immutable-SHA release proof" >&2
fi
# Parallel-aware checkouts already perform scoped + host admission natively.
# Never inherit a caller-supplied mutex bypass for this guarded launcher.
unset AGENTES_CI_LOCK
if grep -q 'Host-bounded local CI:' "$repo/scripts/ci-lock.sh"; then
  cd "$repo"
  exec bun run ci:local
fi
source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
[ -f "$source_dir/ci-lock.sh" ] || { echo "ci parallel: host guard missing" >&2; exit 2; }
# A legacy checkout insists on its own mutex. Outer guard supplies scoped and
# host-wide admission; inner legacy lock gets a separate mutex, avoiding deadlock.
export AGENTES_CI_SCOPE="$repo"
unset AGENTES_CI_LOCK
# The guard is installed beside this wrapper; resolve at runtime.
# shellcheck disable=SC1091
. "$source_dir/ci-lock.sh"
cd "$repo"
ci_lock "host-parallel $(git rev-parse --short HEAD)" || exit 2
state_root="${AGENTES_CI_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentes-chat}"
scope_hash=$(printf '%s' "$repo" | shasum -a 256 | cut -c1-24)
mkdir -p "$state_root/ci-inner"
export AGENTES_CI_LOCK="$state_root/ci-inner/$scope_hash.lock"
echo "ci parallel: bounded slot acquired; launching legacy CI in $repo" >&2
bun run ci:local
