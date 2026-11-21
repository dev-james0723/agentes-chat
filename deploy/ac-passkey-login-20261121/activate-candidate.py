#!/usr/bin/env python3
"""Activate the reviewed Passkey candidate; rollback changes the app image, never the database."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

_spec = importlib.util.spec_from_file_location("passkey_release_build", Path(__file__).with_name("build-candidate.py"))
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)
require = build.require
BASE, BASE_SOURCE = build.BASE, build.BASE_SOURCE
IMAGE_LINE = re.compile(rb"(?m)^([ \t]*(?:export[ \t]+)?AGENTES_IMAGE[ \t]*=)([^\r\n]*)")
ENV_KEYS = re.compile(rb"(?m)^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=")
PROOF_NAMES = ("backupRestore", "migrationRehearsal", "oldAppCompatibility", "isolatedAcceptance")


def image_value(data):
    matches = list(IMAGE_LINE.finditer(data))
    require(len(matches) == 1, "Expected exactly one image-selection key")
    return matches[0].group(2)


def replace_image(data, value):
    require(b"\n" not in value and b"\r" not in value, "Invalid image selector")
    image_value(data)
    return IMAGE_LINE.sub(lambda match: match.group(1) + value, data)


def regular(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "Evidence/configuration must be a regular file")
    return path


def private_bytes(path, data, exclusive=False):
    path = Path(path)
    require(not path.is_symlink(), "Private output must not be a symlink")
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def cas_image(path, expected, replacement):
    path = regular(path)
    require(path.read_bytes() == expected, "Deployment environment changed; reconcile")
    require(replace_image(expected, b"") == replace_image(replacement, b""), "Unrelated environment mutation")
    fd, temporary = tempfile.mkstemp(prefix=".env.ac-passkey-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(replacement)
            stream.flush()
            os.fsync(stream.fileno())
        require(regular(path).read_bytes() == expected, "Deployment environment changed during staging")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class DeploymentLock:
    def __init__(self, path, revision):
        self.path, self.revision = Path(path), revision
        self.token = str(uuid.uuid4())

    def __enter__(self):
        value = {"protocol": "exclusive-create-json-owner-v1", "pid": os.getpid(), "uid": os.getuid(),
                 "writerThread": "ac-passkey-login-20261121", "releaseId": self.revision,
                 "purpose": "Passkey app activation and verification", "createdAt": build.now(), "token": self.token}
        build.private_json(self.path, value, True)
        return self

    def __exit__(self, *_):
        try:
            value = json.loads(regular(self.path).read_text())
        except (OSError, ValueError, RuntimeError):
            return
        if value.get("token") == self.token:
            self.path.unlink()


def safety_evidence(path, candidate, check_age=True, current_time=None):
    evidence = json.loads(regular(path).read_text())
    require(evidence.get("schema") == "ac-passkey-safety-v1"
            and evidence.get("revision") == candidate["revision"]
            and evidence.get("imageId") == candidate["imageId"]
            and evidence.get("baseImageId") == BASE
            and evidence.get("sourceDigest") == candidate["source"]["digest"]
            and evidence.get("migrationSqlSha256") == candidate["migration"]["sqlSha256"],
            "Safety evidence is not bound to this reviewed candidate")
    backup = evidence.get("backup", {})
    require(re.fullmatch(r"[0-9a-f]{64}", backup.get("sha256", "")), "Invalid backup digest")
    backup_path = regular(backup.get("path", ""))
    require(backup_path.stat().st_size > 0 and build.file_sha(backup_path) == backup["sha256"],
            "Database backup is missing or changed")
    completed = datetime.fromisoformat(backup.get("completedAt", "").replace("Z", "+00:00"))
    require(completed.tzinfo is not None, "Backup timestamp must include timezone")
    age = ((current_time or datetime.now(timezone.utc)) - completed).total_seconds()
    require(age >= -60 and (not check_age or age <= 3600), "Take and verify a fresh pre-activation database backup")
    checks = evidence.get("checks", {})
    for name in PROOF_NAMES:
        proof = checks.get(name, {})
        require(proof.get("passed") is True and re.fullmatch(r"[0-9a-f]{64}", proof.get("sha256", "")),
                "A required independently observed safety check is missing: " + name)
        proof_path = regular(proof.get("path", ""))
        require(proof_path.stat().st_size > 0 and build.file_sha(proof_path) == proof["sha256"],
                "Safety proof artifact changed: " + name)
    require(checks["backupRestore"].get("backupSha256") == backup["sha256"],
            "Restore proof does not identify the exact retained backup")
    require(checks["oldAppCompatibility"].get("imageId") == candidate["fallback"]["imageId"]
            and checks["oldAppCompatibility"].get("sourceDigest") == candidate["fallback"]["source"]["digest"],
            "Compatibility proof must identify the tested fallback image, not the incompatible original image")
    return evidence


def candidate_evidence(path, revision, docker):
    candidate = json.loads(regular(path).read_text())
    require(re.fullmatch(r"[0-9a-f]{40}", revision) and candidate.get("schema") == "ac-passkey-candidate-v1"
            and candidate.get("revision") == revision and candidate.get("baseRevision") == build.BASE_REV
            and candidate.get("baseImageId") == BASE and candidate.get("baseSource") == BASE_SOURCE
            and candidate.get("sourceVerified") is True, "Candidate receipt identity mismatch")
    migration = candidate.get("migration", {})
    require(re.fullmatch(r"0283_[a-z0-9_]+", migration.get("tag", ""))
            and re.fullmatch(r"[0-9a-f]{64}", migration.get("sqlSha256", ""))
            and isinstance(migration.get("when"), int) and migration.get("table") == "passkeys", "Invalid migration identity")
    build.verify_image(docker, candidate["imageId"], revision, candidate["source"])
    js = 'import {runningSourceIdentity} from "./apps/server/src/source-identity.ts"; console.log(JSON.stringify(await runningSourceIdentity()()));'
    actual = json.loads(build.output(docker + ["run", "--rm", "--network=none", "--read-only", "-w", "/app", "--entrypoint", "bun", candidate["imageId"], "-e", js]))
    require(actual == candidate["source"], "Candidate image source does not match its receipt")
    fallback = candidate.get("fallback", {})
    require(fallback.get("baseCodeRevision") == build.BASE_REV and fallback.get("migrationRevision") == revision
            and fallback.get("sourceKind") == "base-plus-passkey-migration" and fallback.get("sourceVerified") is True,
            "Migration-compatible fallback is not bound to this candidate")
    build.verify_image(docker, fallback["imageId"], "", fallback["source"])
    fallback_actual = json.loads(build.output(docker + ["run", "--rm", "--network=none", "--read-only", "-w", "/app",
                                  "--entrypoint", "bun", fallback["imageId"], "-e", js]))
    require(fallback_actual == fallback["source"], "Fallback source identity mismatch")
    require(build.image_preservation(docker, fallback["imageId"]) == build.image_preservation(docker, BASE)
            == fallback.get("preserved"), "Fallback no longer preserves original assets/dependency lock/runner")
    assets = candidate.get("assets", {})
    manifest_path = regular(candidate.get("manifestPath", ""))
    raw = manifest_path.read_bytes()
    require(len(raw) < 8 * 1024 * 1024 and build.sha(raw) == assets.get("manifestSha256"), "Asset manifest changed")
    manifest = json.loads(raw)
    require(isinstance(manifest, dict) and len(manifest) == assets.get("count") and "index.html" in manifest,
            "Asset manifest is incomplete")
    for name, digest in manifest.items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and ".." not in relative.parts and "\\" not in name
                and name == relative.as_posix() and re.fullmatch(r"[0-9a-f]{64}", digest), "Invalid asset path or digest")
    require(assets.get("runnerSha256") == build.RUNNER_SHA and manifest.get("runner/agentes-runner.mjs") == build.RUNNER_SHA,
            "Distributed runner is not preserved")
    return candidate, manifest


def compose_environment(expected):
    file_keys = {key.decode() for key in ENV_KEYS.findall(expected)}
    excluded = file_keys | {"AGENTES_IMAGE", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}
    return {key: value for key, value in os.environ.items() if key not in excluded and not key.startswith("COMPOSE_")}


class Activation:
    def __init__(self, args, candidate, manifest):
        self.args, self.candidate, self.manifest = args, candidate, manifest
        self.runtime = args.runtime_dir.expanduser().absolute()
        require(self.runtime.is_dir() and not self.runtime.is_symlink(), "Runtime must be the verified directory")
        for name in (args.project, args.service, args.container):
            require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name), "Invalid Compose identity")
        require(args.container == args.project + "-" + args.service + "-1", "Unexpected app service container")
        self.docker = [str(args.docker), "--context", args.docker_context]
        self.env_path = regular(self.runtime / ".env")
        self.compose_path = regular(self.runtime / "docker-compose.yml")
        self.compose_bytes = self.compose_path.read_bytes()
        self.origin = build.local_origin(args.http_origin)
        self.evidence = build.evidence_directory(args.evidence_dir, build.REPO)
        self.record_path = self.evidence / ("activation-" + candidate["revision"][:12] + ".json")

    def save(self, record, exclusive=False):
        build.private_json(self.record_path, record, exclusive)

    def idle(self):
        query = """SELECT json_build_object(
'executingRuns',(SELECT count(*) FROM agent_runs WHERE status NOT IN ('done','failed','canceled','waiting_input')),
'waitingInput',(SELECT count(*) FROM agent_runs WHERE status='waiting_input'),
'machineWork',(SELECT count(*) FROM machine_tasks WHERE ended_at IS NULL AND status IN ('queued','running','interrupted')));"""
        activity = json.loads(build.output([str(self.args.read_only_query), query]))
        require(all(isinstance(activity.get(k), int) and not isinstance(activity[k], bool) and activity[k] >= 0
                    for k in ("executingRuns", "waitingInput", "machineWork")), "Invalid read-only activity result")
        require(activity["executingRuns"] == 0 and activity["machineWork"] == 0,
                "Live work is executing or pending; wait for a safe cutover")
        return activity

    def containers(self, allowed, require_running=False):
        names = build.output(self.docker + ["container", "ls", "--all", "--format", "{{.Names}}",
                     "--filter", "label=com.docker.compose.project=" + self.args.project,
                     "--filter", "label=com.docker.compose.service=" + self.args.service]).splitlines()
        require(not require_running or self.args.container in names, "Expected running app container is absent")
        for name in names:
            fields = '{{json .Image}}\n{{json .Config.Labels}}\n{{json .State.Running}}'
            image_id, labels, running = map(json.loads, build.output(self.docker + ["inspect", "--format", fields, name]).splitlines())
            labels = labels or {}
            require(image_id in allowed and labels.get("com.docker.compose.project") == self.args.project
                    and labels.get("com.docker.compose.service") == self.args.service
                    and labels.get("com.docker.compose.project.working_dir") == str(self.runtime)
                    and labels.get("com.docker.compose.project.config_files") == str(self.compose_path)
                    and labels.get("com.docker.compose.oneoff", "").lower() == "false",
                    "Another release or configuration owns an app service container")
            require(not (name == self.args.container and require_running) or running is True,
                    "Expected baseline app is not running")
        # An unrelated container using the target name must never be overwritten.
        if self.args.container not in names:
            result = subprocess.run(self.docker + ["container", "inspect", "--format", "{{.Id}}", self.args.container], text=True, capture_output=True)
            missing = {"Error: No such container: " + self.args.container, "Error: No such object: " + self.args.container}
            require(result.returncode == 1 and not result.stdout.strip() and result.stderr.strip() in missing,
                    "Unable to establish that the scoped app container is absent")

    def compose_config(self, expected):
        require(regular(self.env_path).read_bytes() == expected and regular(self.compose_path).read_bytes() == self.compose_bytes,
                "Runtime configuration changed; reconcile")
        command = [str(self.args.compose_bin), "--project-directory", str(self.runtime), "-p", self.args.project,
                   "-f", str(self.compose_path), "--env-file", str(self.env_path)]
        environment = compose_environment(expected)
        environment["DOCKER_CONTEXT"] = self.args.docker_context
        environment["COMPOSE_REMOVE_ORPHANS"] = "0"
        result = subprocess.run(command + ["config", "--format", "json"], env=environment, text=True, capture_output=True)
        require(result.returncode == 0, "Unable to resolve scoped Compose configuration")
        config = json.loads(result.stdout)
        service = config.get("services", {}).get(self.args.service, {})
        require(config.get("name") == self.args.project and service.get("image")
                and not service.get("build") and service.get("container_name", self.args.container) == self.args.container
                and service.get("scale", 1) == 1 and service.get("deploy", {}).get("replicas", 1) == 1,
                "Compose does not target the reviewed app service")
        # Keep the existing graceful drain; never force-stop or touch the database/runner service.
        grace = service.get("stop_grace_period")
        require(grace in ("40s", 40, 40.0), "The existing 40-second app drain must be preserved")
        image = build.output(self.docker + ["image", "inspect", service["image"], "--format", "{{.Id}}"])
        require(regular(self.env_path).read_bytes() == expected and regular(self.compose_path).read_bytes() == self.compose_bytes,
                "Configuration changed during Compose resolution")
        return command, environment, image

    def up(self, expected, image, allowed, record, phase, require_running=False):
        command, environment, resolved = self.compose_config(expected)
        require(resolved == image, "Effective image differs from the reviewed immutable image")
        self.containers(allowed, require_running)
        activity = self.idle()
        require(regular(self.env_path).read_bytes() == expected and regular(self.compose_path).read_bytes() == self.compose_bytes,
                "Configuration changed immediately before activation")
        record.update(state=phase + "-recreate-starting", activityBefore=activity)
        self.save(record)
        log = self.evidence / (phase + "-" + self.candidate["revision"][:12] + ".log")
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "wb") as stream:
            result = subprocess.run(command + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", self.args.service],
                                    env=environment, stdout=stream, stderr=subprocess.STDOUT)
        require(result.returncode == 0, "App-only Compose activation failed; inspect private evidence")

    def health(self, image, source):
        deadline = time.monotonic() + 55
        while time.monotonic() < deadline:
            try:
                return build.inspect_live(self.docker, self.args.container, self.origin, image, source)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                time.sleep(1)
        raise RuntimeError("Matching app image/source/database health did not become ready")

    def served(self, path):
        url = self.origin + "/" + urllib.parse.quote(path, safe="/-._~")
        request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=10) as response:
            require(response.status == 200 and response.geturl() == url, "Unexpected served asset response")
            return response.read()

    def verify_live(self):
        health = self.health(self.candidate["imageId"], self.candidate["source"])
        # Every built JS/CSS chunk is checked, including lazy authentication routes, plus index and runner.
        names = [name for name in self.manifest if name == "index.html" or name == "runner/agentes-runner.mjs"
                 or (name.startswith("assets/") and name.endswith((".js", ".mjs", ".css")))]
        for name in names:
            data = self.served("" if name == "index.html" else name)
            require(build.sha(data) == self.manifest[name], "Served asset differs from the candidate: " + name)
        migration = self.candidate["migration"]
        query = ("SELECT json_build_object('migrationApplied',EXISTS(SELECT 1 FROM drizzle.__drizzle_migrations "
                 "WHERE hash='" + migration["sqlSha256"] + "' AND created_at=" + str(migration["when"]) + "),"
                 "'tablePresent',to_regclass('public.passkeys') IS NOT NULL);")
        migrated = json.loads(build.output([str(self.args.read_only_query), query]))
        require(migrated.get("migrationApplied") is True and migrated.get("tablePresent") is True,
                "Live Passkey migration identity was not verified")
        config = json.loads(self.served("api/app/auth-config"))
        require(config.get("passkeys", {}).get("enabled") is True, "Passkey capability is not enabled")
        runner = self.manifest["runner/agentes-runner.mjs"]
        require(runner == build.RUNNER_SHA, "Distributed runner changed")
        return {"health": health, "migration": migrated, "servedAssetCount": len(names),
                "runnerBytesPreserved": True, "passkeysEnabled": True,
                "ownerEnrollmentVerified": False, "hardwareBiometricsVerified": False}

    def preflight(self):
        current = regular(self.env_path).read_bytes()
        require(self.compose_config(current)[2] == BASE, "Current selected image is not the reviewed parent")
        self.containers((BASE,), True)
        health = build.inspect_live(self.docker, self.args.container, self.origin)
        return current, {"health": health, "activity": self.idle(), "composeSha256": build.sha(self.compose_bytes)}

    def rollback(self, record):
        require(record.get("revision") == self.candidate["revision"] and record.get("imageId") == self.candidate["imageId"],
                "Rollback record identity mismatch")
        current = regular(self.env_path).read_bytes()
        require(build.sha(replace_image(current, b"")) == record.get("environmentTemplateSha256"),
                "Unrelated runtime environment changed; reconcile before rollback")
        fallback = self.candidate["fallback"]
        allowed = (BASE, self.candidate["imageId"], fallback["imageId"])
        selected = self.compose_config(current)[2]
        require(selected in allowed, "Another release changed image selection; do not overwrite it")
        self.containers(allowed)
        self.idle()
        restored = replace_image(current, fallback["imageId"].encode())
        record.update(state="rollback-staging", databaseRestorePerformed=False)
        self.save(record)
        cas_image(self.env_path, current, restored)
        self.up(restored, fallback["imageId"], allowed, record, "rollback")
        record.update(state="rolled-back-to-compatible-app", rollbackHealth=self.health(fallback["imageId"], fallback["source"]),
                      rollbackImageId=fallback["imageId"], rollbackVerifiedAt=build.now(),
                      databaseRestorePerformed=False, additiveMigrationRetained=True)
        self.save(record)

    def activate(self, safety):
        original, preflight = self.preflight()
        record = {"schema": "ac-passkey-activation-v1", "startedAt": build.now(), "revision": self.candidate["revision"],
                  "imageId": self.candidate["imageId"], "baseImageId": BASE, "state": "preflight",
                  "fallbackImageId": self.candidate["fallback"]["imageId"],
                  "preflight": preflight, "safetyEvidenceSha256": build.file_sha(self.args.safety_evidence),
                  "backupSha256": safety["backup"]["sha256"], "environmentKeysChanged": ["AGENTES_IMAGE"],
                  "environmentTemplateSha256": build.sha(replace_image(original, b"")),
                  "databaseRestorePerformed": False}
        self.save(record, True)
        private_bytes(self.evidence / ("runtime-env-before-" + self.candidate["revision"][:12]), original, True)
        staged = replace_image(original, self.candidate["imageId"].encode())
        try:
            # Recheck after writing evidence, immediately before the first production mutation.
            require(self.compose_config(original)[2] == BASE, "Baseline changed before activation")
            build.inspect_live(self.docker, self.args.container, self.origin)
            self.idle()
            cas_image(self.env_path, original, staged)
            record["state"] = "image-selected"
            self.save(record)
            self.up(staged, self.candidate["imageId"], (BASE,), record, "activation", True)
            record.update(self.verify_live(), state="activated-awaiting-owner-enrollment", activatedAt=build.now(),
                          otherServicesChanged=False, installedDesktopBinaryChanged=False)
            self.save(record)
        except BaseException as error:
            attempted = record.get("state") in ("activation-recreate-starting", "activated-awaiting-owner-enrollment")
            record.update(failedAt=build.now(), errorClass=type(error).__name__)
            if attempted:
                try:
                    self.rollback(record)
                except BaseException as rollback_error:
                    record.update(state="rollback-required", rollbackErrorClass=type(rollback_error).__name__)
                    self.save(record)
            else:
                try:
                    current = regular(self.env_path).read_bytes()
                    self.containers((BASE,), True)
                    if current == staged:
                        cas_image(self.env_path, staged, original)
                    else:
                        require(current == original, "Another writer changed configuration; reconcile")
                    record["state"] = "aborted-before-recreate"
                    self.save(record)
                except BaseException as restore_error:
                    record.update(state="pre-recreate-reconcile-required", restoreErrorClass=type(restore_error).__name__)
                    self.save(record)
            raise
        return record


def interrupted(_signum, _frame):
    raise KeyboardInterrupt("Termination requested")


def main():
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--safety-evidence", type=Path, required=True)
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--docker", type=Path, required=True)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--compose-bin", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--service", default="agentes")
    parser.add_argument("--container", required=True)
    parser.add_argument("--http-origin", required=True)
    parser.add_argument("--read-only-query", type=Path, required=True)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--activate", action="store_true")
    action.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    docker = [str(args.docker), "--context", args.docker_context]
    candidate, manifest = candidate_evidence(args.receipt, args.expected_revision, docker)
    safety = safety_evidence(args.safety_evidence, candidate, check_age=not args.rollback)
    activation = Activation(args, candidate, manifest)
    lock_path = activation.runtime / ".host-deployment.lock"
    if not (args.activate or args.rollback):
        require(not lock_path.exists() and not lock_path.is_symlink(), "Another release holds the deployment lock")
        _, observation = activation.preflight()
        print(json.dumps({"preflight": "ready", "candidate": candidate["imageId"], "activity": observation["activity"], "activationPerformed": False}))
        return
    with DeploymentLock(lock_path, candidate["revision"]):
        # The supplied proof artifacts are checked again under the same deployment ownership.
        safety = safety_evidence(args.safety_evidence, candidate, check_age=not args.rollback)
        if args.rollback:
            record = json.loads(regular(activation.record_path).read_text())
            activation.rollback(record)
        else:
            record = activation.activate(safety)
    print(json.dumps({"state": record["state"], "revision": candidate["revision"],
                      "imageId": record.get("rollbackImageId", candidate["imageId"]),
                      "receipt": str(activation.record_path), "hardwareBiometricsVerified": False}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit("Passkey activation refused: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
