#!/usr/bin/env bash
# Host-bounded local CI: one full CI per worktree; two full CIs per Mac by
# default. Legacy single-global-lock holders count toward available capacity.
# source scripts/ci-lock.sh && ci_lock "description"
# AGENTES_CI_MAX_PARALLEL=1..4; AGENTES_CI_LOCK_WAIT=seconds.
# AGENTES_CI_STATE_DIR and AGENTES_CI_SCOPE allow isolated tests.
# AGENTES_CI_LOCK overrides the worktree mutex path, NOT the host limit.
_ci_owner_pid() {
  sed -n 's/^pid=//p' "$1/owner" 2>/dev/null | head -1
}
_ci_owner_dir() {
  sed -n 's/^dir=//p' "$1/owner" 2>/dev/null | head -1
}
_ci_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}
_ci_reap_dead() {
  local lock="$1" old relocated
  [ -f "$lock/owner" ] || return 0
  old=$(_ci_owner_pid "$lock")
  [ -n "$old" ] || return 0
  _ci_alive "$old" && return 0
  # Serialize recovery, atomically move dead lock away, then remove known files.
  if mkdir "$lock.reaping" 2>/dev/null; then
    if [ "$(_ci_owner_pid "$lock")" = "$old" ] && ! _ci_alive "$old"; then
      relocated="$lock.stale.$$.$RANDOM"
      if mv "$lock" "$relocated" 2>/dev/null; then
        rm -f "$relocated/owner"
        rmdir "$relocated" 2>/dev/null || :
        echo "ci lock: taking over from a run that is gone (pid=$old)" >&2
      fi
    fi
    rmdir "$lock.reaping" 2>/dev/null || :
  fi
}
_ci_write_owner() {
  local lock="$1" label="$2" tmp="$1/.owner.$$"
  printf 'pid=%s\nlabel=%s\ndir=%s\nsince=%s\n' "$$" "$label" "$CI_SCOPE_DIR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp" || return 1
  mv "$tmp" "$lock/owner"
}
_ci_release() {
  local lock="$1" owner
  [ -n "$lock" ] || return 0
  owner=$(_ci_owner_pid "$lock")
  if [ "$owner" = "$$" ] && [ "$(_ci_owner_dir "$lock")" = "$CI_SCOPE_DIR" ]; then
    rm -f "$lock/owner"
    rmdir "$lock" 2>/dev/null || :
  fi
}
ci_unlock() {
  _ci_release "${CI_SLOT_DIR:-}"
  _ci_release "${CI_LOCK_DIR:-}"
  CI_SLOT_DIR=""
  CI_LOCK_DIR=""
}
_ci_external_holders() {
  local root="$1" own="$2" ext pid extdir
  CI_EXTERNAL_COUNT=0
  CI_EXTERNAL_SAME_SCOPE=0
  for ext in "$root/ci.lock" "$root/parallel-worktrees"/*.lock; do
    [ "$ext" = "$own" ] && continue
    [ -r "$ext/owner" ] || continue
    pid=$(_ci_owner_pid "$ext")
    _ci_alive "$pid" || continue
    CI_EXTERNAL_COUNT=$((CI_EXTERNAL_COUNT + 1))
    extdir=$(_ci_owner_dir "$ext")
    # Legacy invocations may have recorded a symlinked /var vs /private/var path.
    if [ -d "$extdir" ]; then extdir=$(cd "$extdir" && pwd -P) || :; fi
    [ "$extdir" = "$CI_SCOPE_DIR" ] && CI_EXTERNAL_SAME_SCOPE=1
  done
}
ci_lock() {
  local label="${1:-ci}" max="${AGENTES_CI_MAX_PARALLEL:-2}"
  local root lock wait elapsed=0 slot i available reason="" printed=0
  case "$max" in 1|2|3|4) ;; *) echo 'ci lock: parallel limit must be 1..4' >&2; return 2 ;; esac
  wait="${AGENTES_CI_LOCK_WAIT:-14400}"
  case "$wait" in ''|*[!0-9]*) echo 'ci lock: invalid wait seconds' >&2; return 2 ;; esac
  CI_SCOPE_DIR=$(cd "${AGENTES_CI_SCOPE:-$PWD}" && pwd -P) || return 2
  root="${AGENTES_CI_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentes-chat}"
  if [ -n "${AGENTES_CI_LOCK:-}" ]; then
    lock="$AGENTES_CI_LOCK"
  else
    local key
    key=$(printf '%s' "$CI_SCOPE_DIR" | shasum -a 256 | cut -c1-24) || return 2
    lock="$root/ci-worktrees/$key.lock"
  fi
  mkdir -p "$(dirname "$lock")" "$root/ci-slots" || return 2
  CI_LOCK_DIR=""
  CI_SLOT_DIR=""
  until mkdir "$lock" 2>/dev/null; do
    _ci_reap_dead "$lock"
    # With WAIT=0 a provably dead holder must still be recoverable immediately.
    [ ! -d "$lock" ] && continue
    if [ "$printed" -eq 0 ] && [ -r "$lock/owner" ]; then
      echo "ci lock: waiting for pid=$(_ci_owner_pid "$lock") to finish in $CI_SCOPE_DIR" >&2
      printed=1
    fi
    if [ "$elapsed" -ge "$wait" ]; then
      echo "ci lock: worktree busy: $CI_SCOPE_DIR" >&2
      return 1
    fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  CI_LOCK_DIR="$lock"
  _ci_write_owner "$lock" "$label" || { ci_unlock; return 2; }
  trap 'ci_unlock' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  while :; do
    _ci_external_holders "$root" "$lock"
    available=$((max - CI_EXTERNAL_COUNT))
    if [ "$CI_EXTERNAL_SAME_SCOPE" -eq 1 ]; then
      reason="same worktree has a legacy running CI"
    elif [ "$available" -gt 0 ]; then
      for ((i=1; i<=available; i++)); do
        slot="$root/ci-slots/slot-$i.lock"
        _ci_reap_dead "$slot"
        if mkdir "$slot" 2>/dev/null; then
          CI_SLOT_DIR="$slot"
          _ci_write_owner "$slot" "$label" || { ci_unlock; return 2; }
          echo "ci lock: admitted slot $i/$max ($CI_SCOPE_DIR)" >&2
          return 0
        fi
      done
      reason="all parallel CI slots occupied"
    else
      reason="parallel CI limit $max reached (including legacy holders)"
    fi
    if [ "$elapsed" -ge "$wait" ]; then
      echo "ci lock: $reason; no slot after ${elapsed}s" >&2
      ci_unlock
      return 1
    fi
    if [ $((elapsed % 15)) -eq 0 ]; then echo "ci lock: waiting: $reason" >&2; fi
    sleep 1; elapsed=$((elapsed + 1))
  done
}
