#!/usr/bin/env bash
# The image as self-hosters run it, on this machine: the same steps as CI's "Image boots with docker compose" and
# "Back up and restore" jobs (.github/workflows/ci.yml), under its own compose project, port and volumes, so a
# running deployment on the same Docker host is never touched. Builds from the current directory (the candidate).
#
# Needs DOCKER_HOST pointing at a Docker host that is NOT the production one, and CI_CANDIDATE_SHA.
set -euo pipefail
: "${CI_CANDIDATE_SHA:?CI_CANDIDATE_SHA is required}"
: "${DOCKER_HOST:?DOCKER_HOST must name a dedicated CI Docker host}"
case "$DOCKER_HOST" in
  *agentes-chat-local*) echo "refusing: $DOCKER_HOST is the production Docker host" >&2; exit 2 ;;
esac

root=$(pwd)
tag=${CI_CANDIDATE_SHA:0:12}
project="agentes-ci-$tag"
port=${CI_BOOT_PORT:-39300}
work=$(mktemp -d "${TMPDIR:-/tmp}/agentes-boot.XXXXXX")
export AGENTES_IMAGE="agentes-ci:$tag" AGENTES_BACKUP_IMAGE="agentes-backup-ci:$tag"
export HOST_PORT=$port BIND_ADDRESS=127.0.0.1
URL="http://127.0.0.1:$port"
compose() { docker-compose -p "$project" --project-directory "$work" -f "$root/docker-compose.yml" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --no-color > "$work/compose.log" 2>&1 || true; tail -200 "$work/compose.log" || true; fi
  compose down -v --remove-orphans > /dev/null 2>&1 || true
  docker rm -f "$project-s3" > /dev/null 2>&1 || true
  docker image rm "$AGENTES_IMAGE" "$AGENTES_BACKUP_IMAGE" > /dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

echo "== build $AGENTES_IMAGE from $(git rev-parse HEAD)"
test "$(git rev-parse HEAD)" = "$CI_CANDIDATE_SHA"
docker build -q -t "$AGENTES_IMAGE" .
docker build -q -t "$AGENTES_BACKUP_IMAGE" deploy/backup

printf 'AGENTES_SECRET=%s\nPOSTGRES_PASSWORD=%s\nPUBLIC_URL=%s\n' \
  "$(openssl rand -base64 48)" "$(openssl rand -hex 16)" "$URL" > "$work/.env"
PASSWORD=$(openssl rand -hex 12)
cd "$work"

echo "== boot"
compose up -d postgres agentes
healthy() {
  for _ in $(seq 120); do
    curl -fs "$URL/api/health" > health.json && return 0
    sleep 2
  done
  return 1
}
signup() {
  curl -s -o /dev/null -w '%{http_code}' -H "Origin: $URL" -H 'Content-Type: application/json' \
    -d "{\"name\":\"CI\",\"email\":\"$1\",\"password\":\"$PASSWORD\"}" "${@:2}" "$URL/api/auth/sign-up/email"
}
healthy
cat health.json; echo
jq -e '.status == "ok" and .edition == "selfhost"' health.json
test "$(signup owner@ci.invalid -c cookies.txt)" = 200
curl -fs -b cookies.txt "$URL/api/app/me" | jq -e '.user.email == "owner@ci.invalid"'
curl -fs -b cookies.txt -H "Origin: $URL" -H 'Content-Type: application/json' -d '{"name":"CI"}' \
  "$URL/api/app/organizations" | jq -e '.generalChannelId'
test "$(signup second@ci.invalid)" = 403
curl -fs "$URL/" -o index.html
grep -q 'id="root"' index.html
curl -fs "$URL/runner/agentes-runner.mjs" -o runner.mjs
test "$(head -1 runner.mjs)" = '#!/usr/bin/env node'
curl -fs "$URL/install" | cmp - "$root/install.sh"

echo "== restart on the same volumes, migrations first"
compose down
compose run --rm agentes migrate
compose up -d postgres agentes
healthy
curl -fs -b cookies.txt "$URL/api/app/me" | jq -e '.organizations | length == 1'
compose run --rm -T agentes telemetry > report.json
jq -e '.report == 1 and .install == "docker" and .host.container and .people.total == 1' report.json

echo "== back up and restore"
printf 'S3_ENDPOINT=http://s3:8080\nS3_PROVIDER=Rclone\nS3_ACCESS_KEY_ID=ci-key\nS3_SECRET_ACCESS_KEY=ci-secret\nS3_BACKUP_BUCKET=backups\n' >> .env
compose run -d --name "$project-s3" --entrypoint sh backup -c \
  'mkdir -p /tmp/s3/backups && exec rclone serve s3 --auth-key ci-key,ci-secret --addr :8080 /tmp/s3'
sleep 3
compose run --rm backup now
name=$(compose run --rm -T backup list | awk '{print $NF}' | tail -1)
compose run --rm -T backup fetch "$name" > ci.dump
compose exec -T postgres createdb -U agentes restored
compose exec -T postgres pg_restore -U agentes -d restored --exit-on-error < ci.dump
compose exec -T postgres psql -U agentes -d restored -tAc 'select email from users' | grep -x owner@ci.invalid
echo "== container boot passed for $CI_CANDIDATE_SHA"
