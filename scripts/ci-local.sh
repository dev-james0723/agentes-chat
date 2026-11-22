#!/usr/bin/env bash
# Every check of .github/workflows/ci.yml that runs without Docker, in the same order, on this checkout.
# Prints a PASS/FAIL table and exits non-zero if any step fails; each step's output is in the log it names.
# The image boot (CI's compose job) needs Docker and is not run here.
# Usage: bun run ci:local
set -u
cd "$(dirname "$0")/.." || exit 2
# The physical checkout is the only valid lock scope; never trust a caller override.
export AGENTES_CI_SCOPE="$PWD"
# Full CI may regenerate migrations. Never run it over an agent's uncommitted work.
if [ -n "$(git status --porcelain)" ]; then
  echo "ci:local refused: worktree is not clean; commit or use a separate isolated checkout" >&2
  exit 2
fi
log=$(mktemp "${TMPDIR:-/tmp}/agentes-ci-local.XXXXXX")
export CI=true
results=()
failed=0

step() {
  local name=$1 command=$2
  printf '\n=== %s\n' "$name" >> "$log"
  local t0=$SECONDS
  if (eval "$command") >> "$log" 2>&1; then
    results+=("PASS  $name ($((SECONDS - t0))s)")
  else
    results+=("FAIL  $name ($((SECONDS - t0))s)")
    failed=1
  fi
}

need() {
  command -v "$1" > /dev/null || { echo "missing: $1 ($2)" >&2; exit 2; }
}
need bun "https://bun.sh"
need shellcheck "brew install shellcheck, or apt-get install shellcheck"
need gitleaks "brew install gitleaks, or https://github.com/gitleaks/gitleaks/releases"

# Bounded parallel CI: up to two independent worktrees at once (configurable
# via AGENTES_CI_MAX_PARALLEL); still only one full run per worktree.
# Legacy global-lock holders count against capacity. Shared external fixtures
# must have their own named resource locks instead of bypassing this guard.
# shellcheck source=scripts/ci-lock.sh
. scripts/ci-lock.sh
ci_lock "ci-local $(git rev-parse --short HEAD)" || exit 2

echo "local CI on $(git rev-parse --short HEAD), log: $log"
step "install" "bun install --frozen-lockfile"
step "lint and format" "bun run lint"
step "shell scripts" "shellcheck install.sh deploy/*.sh deploy/backup/*.sh scripts/*.sh"
step "delivery guardian" "node --test scripts/delivery/*.test.mjs"
step "boundaries check's own test" "bun test scripts/check-boundaries.test.ts"
step "geometry check's own test" "bun test scripts/geometry/check.test.ts"
step "dependency licenses" "bun test scripts/check-licenses.test.ts && bun run check:licenses"
step "typecheck" "bun run typecheck"
step "build web and server" "bun run build"
# Regeneration must be fail-closed and non-destructive. Keep any drift visible
# for the integration owner rather than deleting generated or concurrent files.
# shellcheck disable=SC2329
check_migration_drift() {
  local changed
  changed=$(git status --porcelain -- packages/db/migrations)
  if [ -n "$changed" ]; then
    echo "migration check blocked: pre-existing generated or uncommitted migration files" >&2
    return 1
  fi
  bun run db:generate ci-drift-check < /dev/null || return 1
  changed=$(git status --porcelain -- packages/db/migrations)
  if [ -n "$changed" ]; then
    printf "migration drift detected; generated files preserved for review:\n%s\n" "$changed" >&2
    return 1
  fi
}
step "migrations up to date with the schema" "check_migration_drift"
step "migrations keep the running version working" "bun test scripts/check-migrations.test.ts && bun run check:migrations"
step "deploy and backup scripts" "bun test ./deploy/deploy.test.ts"
step "test backend 1/3" "bun test packages/engine/test/[a-m]*.test.ts"
step "test backend 2/3" "bun test packages/engine/test/[!a-m]*.test.ts packages/adapters packages/config packages/db packages/modules packages/providers packages/client packages/i18n packages/tokens packages/setup"
step "test backend 3/3" "bun test apps/server"
geometry=$(mktemp -d "${TMPDIR:-/tmp}/agentes-geometry.XXXXXX")
step "test web and design system" "GEOMETRY_OUT=$geometry bun test --preload ./scripts/geometry/capture.ts apps/web packages/ui"
step "geometry" "bun run check:geometry $geometry --text-size xs,xl"
rm -rf "$geometry"
step "test new event dialog alone" "RUN_NEW_EVENT=1 bun test --timeout 20000 apps/web/test/new-event.test.tsx"
step "test phone and desktop apps" "bun test apps/mobile/test apps/desktop/test"
# This branch's own history: other local branches' commits are theirs to scan.
step "secret scan" "gitleaks git --config .gitleaks.toml --log-opts=HEAD --no-banner --redact --exit-code 1 ."
step "boundaries" "bun run check:boundaries"

printf '%s\n' "${results[@]}"
echo "log: $log"
exit $failed
