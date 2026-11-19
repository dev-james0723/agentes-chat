#!/usr/bin/env bash
# One full local CI run at a time on this computer. Several checkouts (worktrees, agents) running the whole suite at
# once share the same cores: tests that wait on a timer then time out and the runs prove nothing. A run takes the lock
# before its first step and gives it back when it ends; another run waits for it, saying whose run it waits on.
#
#   source scripts/ci-lock.sh && ci_lock "label"
#
# The lock is a directory (mkdir is atomic) holding who took it. A lock whose process is gone is taken over.
# AGENTES_CI_LOCK sets its path (default: one per user, outside any checkout); AGENTES_CI_LOCK_WAIT the longest wait in
# seconds (default 4 hours, 0 to fail at once when another run holds it).

ci_lock() {
  local label=${1:-ci}
  local lock=${AGENTES_CI_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/agentes-chat/ci.lock}
  local wait=${AGENTES_CI_LOCK_WAIT:-14400}
  local waited=0 said=""
  mkdir -p "$(dirname "$lock")" || return 2
  while ! mkdir "$lock" 2> /dev/null; do
    local pid
    pid=$(sed -n 's/^pid=//p' "$lock/owner" 2> /dev/null)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2> /dev/null; then
      # Its run ended without giving it back (killed, crashed): nothing runs under it any more.
      echo "ci lock: taking over from a run that is gone ($(tr '\n' ' ' < "$lock/owner"))" >&2
      rm -rf "$lock"
      continue
    fi
    if [ -z "$pid" ] && [ -d "$lock" ] && [ -z "$said" ]; then
      # Taken a moment ago, its owner not written yet: look again shortly.
      sleep 1
      said=starting
      continue
    fi
    if [ "$waited" -ge "$wait" ]; then
      echo "ci lock: another run still holds it after ${waited}s: $(tr '\n' ' ' < "$lock/owner" 2> /dev/null)" >&2
      return 1
    fi
    if [ "$said" != waiting ]; then
      echo "ci lock: waiting for $(tr '\n' ' ' < "$lock/owner" 2> /dev/null)" >&2
      said=waiting
    fi
    sleep 15
    waited=$((waited + 15))
  done
  printf 'pid=%s\nlabel=%s\ndir=%s\nsince=%s\n' "$$" "$label" "$PWD" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock/owner"
  CI_LOCK_DIR=$lock
  trap 'ci_unlock' EXIT
  trap 'ci_unlock; exit 130' INT TERM
}

ci_unlock() {
  if [ -n "${CI_LOCK_DIR:-}" ] && [ "$(sed -n 's/^pid=//p' "$CI_LOCK_DIR/owner" 2> /dev/null)" = "$$" ]; then
    rm -rf "$CI_LOCK_DIR"
  fi
  CI_LOCK_DIR=""
}
