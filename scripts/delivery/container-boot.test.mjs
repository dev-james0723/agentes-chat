import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./container-boot.sh", import.meta.url));
const sha = "0123456789abcdef0123456789abcdef01234567";
const s3Container = "agentes-ci-0123456789ab-s3";
const stubs = String.raw`# Loaded by BASH_ENV to replace external effects of container-boot.sh.
trace() { printf '%s\n' "$*" >> "$BOOT_TRACE"; }

docker() {
  case "$1" in
    info) printf '%s\n' "$DOCKER_HOST" ;;
    build|image) ;;
    rm) trace "remove $3" ;;
    *) return 97 ;;
  esac
}

docker-compose() {
  shift 6 # -p NAME --project-directory DIR -f FILE
  case "$*" in
    'up -d postgres agentes'|'down'|'run --rm agentes migrate') ;;
    'run --rm -T agentes telemetry') printf '{}\n' ;;
    'run -d --name '*) trace "start $4" ;;
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
  { name: "container boot uses fixture S3 settings despite inherited values", backupStatus: 0, scratchDeleteStatus: 0 },
  {
    name: "container boot preserves backup failure when scratch deletion fails",
    backupStatus: 37,
    scratchDeleteStatus: 41,
  },
];

for (const { name, backupStatus, scratchDeleteStatus } of cases) {
  test(name, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "container-boot-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bashEnv = join(directory, "stubs.bash");
    const traceFile = join(directory, "trace");
    writeFileSync(bashEnv, stubs);
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
        BOOT_TRACE: traceFile,
        BACKUP_STATUS: String(backupStatus),
        SCRATCH_DELETE_STATUS: String(scratchDeleteStatus),
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
    assert.equal(result.status, backupStatus, result.stdout + result.stderr);
    if (backupStatus === 0) {
      assert.match(result.stdout, /container boot passed/);
    } else {
      assert.match(result.stdout, /fixture compose diagnostics/);
      assert.match(result.stderr, /fixture scratch deletion failed/);
    }
    assert.deepEqual(readFileSync(traceFile, "utf8").trim().split("\n"), [
      `start ${s3Container}`,
      `S3_ENDPOINT=http://${s3Container}:8080`,
      "S3_REGION=",
      "S3_PROVIDER=Rclone",
      "S3_ACCESS_KEY_ID=ci-key",
      "S3_SECRET_ACCESS_KEY=ci-secret",
      "S3_BACKUP_BUCKET=backups",
      backupStatus === 0 ? "restore" : "logs",
      `remove ${s3Container}`,
      "teardown",
      "scratch cleanup",
    ]);
  });
}
