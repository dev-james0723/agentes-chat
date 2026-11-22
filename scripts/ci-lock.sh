#!/usr/bin/env bash
# Host-bounded local CI: one writer per worktree; bounded parallel Mac slots.
# Atomic PID-bearing owner files + OS flock admission eliminate orphaned
# ownerless mkdir locks. The unmanaged old global CI entrypoint is reserved.
# Source with: . scripts/ci-lock.sh && ci_lock "branch head"
# AGENTES_CI_MAX_PARALLEL=1..4 (default 2), AGENTES_CI_LOCK_WAIT=seconds.
# AGENTES_CI_LEGACY_EXCLUDED=1 ONLY after owner-verified cutover.
# CI_STATE_DIR / CI_SCOPE / AGENTES_CI_LOCK may be overridden for isolated tests.

_CI_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
_CI_ADMISSION="$_CI_SCRIPT_DIR/ci-atomic-admission.py"

ci_unlock() {
  if [ -n "${CI_LOCK_DIR:-}" ] && [ -n "${CI_SLOT_DIR:-}" ] && [ -n "${CI_LOCK_TOKEN:-}" ]; then
    python3 "$_CI_ADMISSION" release "$CI_STATE_DIR" "$CI_LOCK_DIR" "$CI_SLOT_DIR" "$$" "$CI_LOCK_TOKEN" ||
      echo "ci lock: guarded release failed; retain proof for reconciliation" >&2
  fi
  CI_LOCK_DIR=""
  CI_SLOT_DIR=""
  CI_LOCK_TOKEN=""
}

ci_lock() {
  local label="${1:-ci}" max="${AGENTES_CI_MAX_PARALLEL:-2}" wait="${AGENTES_CI_LOCK_WAIT:-14400}"
  local root lock key elapsed=0 output rc reason printed=0
  case "$max" in 1|2|3|4) ;; *) echo 'ci lock: parallel limit must be 1..4' >&2; return 2 ;; esac
  case "$wait" in ''|*[!0-9]*) echo 'ci lock: invalid wait seconds' >&2; return 2 ;; esac
  case "${AGENTES_CI_LEGACY_EXCLUDED:-0}" in 0|1) ;; *) echo 'ci lock: invalid legacy cutover setting' >&2; return 2 ;; esac
  command -v python3 >/dev/null || { echo "ci lock: python3 is required for atomic ownership" >&2; return 2; }
  [ -r "$_CI_ADMISSION" ] || { echo "ci lock: atomic admission helper unavailable" >&2; return 2; }
  CI_SCOPE_DIR=$(cd "${AGENTES_CI_SCOPE:-$PWD}" && pwd -P) || return 2
  root="${AGENTES_CI_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentes-chat}"
  if [ -n "${AGENTES_CI_LOCK:-}" ]; then
    lock="$AGENTES_CI_LOCK"
  else
    key=$(printf '%s' "$CI_SCOPE_DIR" | shasum -a 256 | cut -c1-24) || return 2
    lock="$root/ci-worktrees/$key.lock"
  fi
  CI_STATE_DIR="$root"
  CI_LOCK_DIR=""
  CI_SLOT_DIR=""
  CI_LOCK_TOKEN=""
  while :; do
    output=$(python3 "$_CI_ADMISSION" acquire "$root" "$CI_SCOPE_DIR" "$lock" "$max" "$$" "$label" "${AGENTES_CI_LEGACY_EXCLUDED:-0}" "-" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      CI_LOCK_DIR=$(printf '%s\n' "$output" | sed -n 's/^WORKTREE=//p' | head -1)
      CI_SLOT_DIR=$(printf '%s\n' "$output" | sed -n 's/^SLOT=//p' | head -1)
      CI_LOCK_TOKEN=$(printf '%s\n' "$output" | sed -n 's/^TOKEN=//p' | head -1)
      if [ -z "$CI_LOCK_TOKEN" ] || [ -z "$CI_SLOT_DIR" ] || [ -z "$CI_LOCK_DIR" ]; then
        echo "ci lock: admission receipt incomplete; fail closed" >&2
        return 2
      fi
      trap 'ci_unlock' EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM
      echo "ci lock: admitted $(printf '%s\n' "$output" | sed -n 's/^CAPACITY=//p') ($CI_SCOPE_DIR)" >&2
      if printf '%s\n' "$output" | grep -q '^RECOVERED='; then
        echo "ci lock: taking over from a run that is gone (verified dead PID)" >&2
      fi
      return 0
    fi
    if [ "$rc" -ne 1 ]; then
      echo "ci lock: failed to reconcile admission: $output" >&2
      return 2
    fi
    reason=$(printf '%s\n' "$output" | sed -n 's/^BUSY=//p' | head -1)
    if [ "$printed" -eq 0 ] && [ -n "$reason" ]; then
      case "$reason" in
        *"worktree busy, pid="*) echo "ci lock: waiting for pid=${reason##*pid=} ($CI_SCOPE_DIR)" >&2 ;;
        *) echo "ci lock: waiting: $reason" >&2 ;;
      esac
      printed=1
    fi
    if [ "$elapsed" -ge "$wait" ]; then
      echo "ci lock: $reason; no slot after ${elapsed}s" >&2
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}
