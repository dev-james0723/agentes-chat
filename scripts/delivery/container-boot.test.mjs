import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./container-boot.sh", import.meta.url));
const sha = "0123456789abcdef0123456789abcdef01234567";
const imageTag = sha.slice(0, 12);
const project = `agentes-ci-${imageTag}`;
const s3Container = `${project}-s3`;
const s3Endpoint = `http://${s3Container}:8080`;
const probeCommands = String.raw`#!/bin/sh
set -eu

command_name=${"$"}{0##*/}

trace() { printf '%s\n' "$*" >> "$BOOT_TRACE"; }
invalid() { trace "invalid $command_name invocation"; exit 97; }

case "$command_name" in
  timeout)
    [ "$#" -eq 10 ] && [ "$1" = -s ] && [ "$2" = KILL ] && [ "$3" = 2 ] || invalid
    trace "timeout -s KILL 2"
    shift 3
    [ "$1" = rclone ] || invalid
    exec "$@"
    ;;
  rclone)
    [ "$#" -eq 6 ] && [ "$1" = lsd ] && [ "$2" = :s3: ] \
      && [ "$3" = --retries ] && [ "$4" = 1 ] \
      && [ "$5" = --low-level-retries ] && [ "$6" = 1 ] || invalid
    [ "$RCLONE_CONFIG" = /dev/null ] \
      && [ "$RCLONE_S3_PROVIDER" = Rclone ] \
      && [ "$RCLONE_S3_ENDPOINT" = "$BOOT_S3_ENDPOINT" ] \
      && [ "$RCLONE_S3_REGION" = auto ] \
      && [ "$RCLONE_S3_ACCESS_KEY_ID" = ci-key ] \
      && [ "$RCLONE_S3_SECRET_ACCESS_KEY" = ci-secret ] \
      && [ "$RCLONE_S3_NO_CHECK_BUCKET" = true ] || invalid
    attempt=0
    if [ -f "$BOOT_TRACE" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          "probe "*) attempt=$((attempt + 1)) ;;
        esac
      done < "$BOOT_TRACE"
    fi
    IFS=,
    set -- $S3_RESPONSES
    if [ "$attempt" -ge "$#" ]; then attempt=$(($# - 1)); fi
    shift "$attempt"
    trace "probe $1"
    case "$1" in
      empty) exit 0 ;;
      connection) exit 5 ;;
      auth)
        printf 'fixture client error with key %s\n' "$RCLONE_S3_SECRET_ACCESS_KEY" >&2
        exit 7
        ;;
      service) exit 8 ;;
      timeout) kill -KILL "$$" ;;
      *) invalid ;;
    esac
    ;;
  sleep)
    [ "$#" -eq 1 ] && [ "$1" = 1 ] || invalid
    trace "S3 backoff 1"
    ;;
  *) invalid ;;
esac
`;

const stubs = String.raw`# Loaded by BASH_ENV to replace external effects of container-boot.sh.
trace() { printf '%s\n' "$*" >> "$BOOT_TRACE"; }

docker() {
  case "$1" in
    info) printf '%s\n' "$DOCKER_HOST" ;;
    build) ;;
    image) trace "remove images $3 $4" ;;
    rm) trace "remove $3" ;;
    *) return 97 ;;
  esac
}

docker-compose() {
  [ "$1" = -p ] && [ "$2" = "${project}" ] || return 97
  shift 6 # -p NAME --project-directory DIR -f FILE
  case "$*" in
    'up -d postgres agentes'|'down'|'run --rm agentes migrate') ;;
    'run --rm -T agentes telemetry') printf '{}\n' ;;
    'run -d --name '*) trace "start $4" ;;
    'run --rm --no-deps -T --entrypoint sh backup -c '*)
      [ "$#" -eq 9 ] || return 97
      (
        for key in S3_ENDPOINT S3_REGION S3_PROVIDER S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BACKUP_BUCKET; do
          # Compose exports settings from the host environment or the fixture .env.
          value=$(printenv "$key" || sed -n "s/^$key=//p" .env)
          export "$key=$value"
        done
        PATH="$BOOT_PROBE_PATH:$PATH" /bin/sh -c "$9"
      )
      ;;
    'run --rm backup now')
      local key
      for key in S3_ENDPOINT S3_REGION S3_PROVIDER S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BACKUP_BUCKET; do
        # Compose uses the exported environment before values in the project .env.
        trace "$key=$(printenv "$key" || sed -n "s/^$key=//p" .env)"
      done
      return "$BACKUP_STATUS"
      ;;
    'run --rm -T backup list') printf 'fixture.dump\n' ;;
    'run --rm -T backup fetch fixture.dump') printf 'fixture dump\n' ;;
    'exec -T postgres createdb -U agentes restored') ;;
    'exec -T postgres pg_restore -U agentes -d restored --exit-on-error')
      read -r dump && [ "$dump" = 'fixture dump' ] || return 97
      trace restore
      ;;
    'exec -T postgres psql '*) printf 'owner@ci.invalid\n' ;;
    'logs --no-color')
      trace logs
      printf 'fixture compose diagnostics\n'
      ;;
    'down -v --remove-orphans') trace teardown ;;
    *) return 97 ;;
  esac
}

curl() {
  local arg url
  for arg in "$@"; do
    case "$arg" in http://*) url=$arg ;; esac
  done
  case "$url" in
    */api/auth/sign-up/email)
      case "$*" in
        *owner@ci.invalid*) printf 200 ;;
        *second@ci.invalid*) printf 403 ;;
        *) return 97 ;;
      esac
      ;;
    */api/health|*/api/app/me|*/api/app/organizations) printf '{}\n' ;;
    */runner/agentes-runner.mjs) printf '#!/usr/bin/env node\n' > runner.mjs ;;
    */install) printf 'fixture installer\n' ;;
    */) printf '<div id="root"></div>\n' > index.html ;;
    *) return 97 ;;
  esac
}

rm() {
  trace "scratch cleanup"
  if [ "$SCRATCH_DELETE_STATUS" -ne 0 ]; then
    printf 'fixture scratch deletion failed\n' >&2
    return "$SCRATCH_DELETE_STATUS"
  fi
  command rm "$@"
}

# These checks are outside the container wiring this fixture exercises.
jq() { if [ "$#" -eq 2 ]; then cat >/dev/null; fi; }
openssl() { printf 'fixture-password\n'; }
git() { printf '%s\n' "$CI_CANDIDATE_SHA"; }
sleep() { :; }
`;

const cases = [
  { name: "container boot uses fixture S3 settings for a signed empty root listing", s3Responses: ["empty"] },
  {
    name: "container boot preserves backup failure when scratch deletion fails",
    s3Responses: ["empty"],
    backupStatus: 37,
    scratchDeleteStatus: 41,
  },
  {
    name: "container boot retries S3 connection and auth failures before backup",
    s3Responses: ["connection", "auth", "empty"],
  },
  {
    name: "container boot skips backup and cleans up after persistent S3 auth failure",
    s3Responses: ["auth"],
    attempts: 30,
    readinessStatus: 7,
    scratchDeleteStatus: 41,
  },
  {
    name: "container boot skips backup and cleans up after persistent S3 service failure",
    s3Responses: ["service"],
    attempts: 30,
    readinessStatus: 8,
  },
  {
    name: "container boot skips backup and cleans up after exhausting S3 process timeouts",
    s3Responses: ["timeout"],
    attempts: 30,
    readinessStatus: 137,
  },
];

for (const {
  name,
  s3Responses,
  attempts = s3Responses.length,
  readinessStatus = 0,
  backupStatus = 0,
  scratchDeleteStatus = 0,
} of cases) {
  test(name, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "container-boot-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bashEnv = join(directory, "stubs.bash");
    const probePath = join(directory, "probe");
    const traceFile = join(directory, "trace");
    writeFileSync(bashEnv, stubs);
    mkdirSync(probePath);
    writeFileSync(join(probePath, "fixture"), probeCommands, { mode: 0o755 });
    for (const command of ["timeout", "rclone", "sleep"]) {
      symlinkSync("fixture", join(probePath, command));
    }
    writeFileSync(traceFile, "");
    writeFileSync(join(directory, "install.sh"), "fixture installer\n");

    const result = spawnSync("bash", [script], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        TMPDIR: directory,
        BASH_ENV: bashEnv,
        BOOT_PROBE_PATH: probePath,
        BOOT_S3_ENDPOINT: s3Endpoint,
        BOOT_TRACE: traceFile,
        BACKUP_STATUS: String(backupStatus),
        SCRATCH_DELETE_STATUS: String(scratchDeleteStatus),
        S3_RESPONSES: s3Responses.join(","),
        CI_CANDIDATE_SHA: sha,
        DOCKER_HOST: "unix:///fixture-ci",
        CI_PRODUCTION_DOCKER_HOST: "unix:///fixture-production",
        S3_ENDPOINT: "https://ambient-s3.example.invalid",
        S3_REGION: "ambient-region",
        S3_PROVIDER: "ambient-provider",
        S3_ACCESS_KEY_ID: "ambient-key",
        S3_SECRET_ACCESS_KEY: "ambient-secret",
        S3_BACKUP_BUCKET: "ambient-bucket",
      },
    });

    assert.ifError(result.error);
    const expectedStatus = readinessStatus || backupStatus;
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    if (expectedStatus === 0) {
      assert.match(result.stdout, /container boot passed/);
    } else {
      assert.match(result.stdout, /fixture compose diagnostics/);
    }
    if (scratchDeleteStatus !== 0) {
      assert.match(result.stderr, /fixture scratch deletion failed/);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /ci-key|ci-secret|ambient-key|ambient-secret/);
    if (readinessStatus) {
      assert.ok(
        result.stderr.includes(
          `S3 fixture was not ready after ${attempts} attempts (probe exit status: ${readinessStatus})`,
        ),
        result.stderr,
      );
    }
    const probeTrace = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) probeTrace.push("S3 backoff 1");
      const outcome = s3Responses[Math.min(attempt, s3Responses.length - 1)];
      probeTrace.push("timeout -s KILL 2", `probe ${outcome}`);
    }
    assert.deepEqual(readFileSync(traceFile, "utf8").trim().split("\n"), [
      `start ${s3Container}`,
      ...probeTrace,
      ...(readinessStatus
        ? []
        : [
            `S3_ENDPOINT=${s3Endpoint}`,
            "S3_REGION=",
            "S3_PROVIDER=Rclone",
            "S3_ACCESS_KEY_ID=ci-key",
            "S3_SECRET_ACCESS_KEY=ci-secret",
            "S3_BACKUP_BUCKET=backups",
          ]),
      expectedStatus === 0 ? "restore" : "logs",
      `remove ${s3Container}`,
      "teardown",
      `remove images agentes-ci:${imageTag} agentes-backup-ci:${imageTag}`,
      "scratch cleanup",
    ]);
  });
}
