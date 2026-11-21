"""Offline negative-path tests. No Docker, live configuration, network or database access."""
from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load("passkey_build_tests", "build-candidate.py")
activate = load("passkey_activation_tests", "activate-candidate.py")


class ReleaseSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_image_change_preserves_every_other_byte(self):
        original = b"# fixture\r\nVALUE=not-a-secret\r\n export AGENTES_IMAGE = 'old' # comment\r\nOTHER=preserved\r\n"
        changed = activate.replace_image(original, b"sha256:new")
        self.assertEqual(changed, b"# fixture\r\nVALUE=not-a-secret\r\n export AGENTES_IMAGE =sha256:new\r\nOTHER=preserved\r\n")
        self.assertEqual(activate.replace_image(original, b""), activate.replace_image(changed, b""))

    def test_duplicate_exported_and_plain_image_keys_rejected(self):
        with self.assertRaises(RuntimeError):
            activate.replace_image(b"AGENTES_IMAGE=a\nexport AGENTES_IMAGE=b\n", b"c")

    def test_newline_injected_image_rejected(self):
        with self.assertRaises(RuntimeError):
            activate.replace_image(b"AGENTES_IMAGE=a\n", b"b\nUNRELATED=value")

    def test_cas_refuses_concurrent_environment_change(self):
        target = self.root / ".env"
        target.write_bytes(b"AGENTES_IMAGE=other-release\n")
        with self.assertRaises(RuntimeError):
            activate.cas_image(target, b"AGENTES_IMAGE=old\n", b"AGENTES_IMAGE=new\n")
        self.assertEqual(target.read_bytes(), b"AGENTES_IMAGE=other-release\n")

    def test_cas_refuses_unrelated_mutation(self):
        target = self.root / ".env"
        original = b"AGENTES_IMAGE=old\nPRESERVE=x\n"
        target.write_bytes(original)
        with self.assertRaises(RuntimeError):
            activate.cas_image(target, original, b"AGENTES_IMAGE=new\nPRESERVE=y\n")
        self.assertEqual(target.read_bytes(), original)

    def test_cas_symlink_never_changes_target(self):
        outside = self.root / "unrelated"
        outside.write_bytes(b"AGENTES_IMAGE=old\n")
        target = self.root / ".env"
        target.symlink_to(outside)
        with self.assertRaises(RuntimeError):
            activate.cas_image(target, outside.read_bytes(), b"AGENTES_IMAGE=new\n")
        self.assertEqual(outside.read_bytes(), b"AGENTES_IMAGE=old\n")

    def test_cas_success_is_private_and_changes_only_image(self):
        target = self.root / ".env"
        old = b"AGENTES_IMAGE=old\nKEEP=fixture\n"
        target.write_bytes(old)
        activate.cas_image(target, old, b"AGENTES_IMAGE=new\nKEEP=fixture\n")
        self.assertEqual(target.read_bytes(), b"AGENTES_IMAGE=new\nKEEP=fixture\n")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_existing_lock_is_never_taken_over(self):
        path = self.root / ".host-deployment.lock"
        with activate.DeploymentLock(path, "a" * 40):
            before = path.read_bytes()
            with self.assertRaises(FileExistsError):
                with activate.DeploymentLock(path, "b" * 40):
                    self.fail("second writer acquired lock")
            self.assertEqual(path.read_bytes(), before)
        self.assertFalse(path.exists())

    def test_lock_release_preserves_changed_owner(self):
        path = self.root / ".host-deployment.lock"
        with activate.DeploymentLock(path, "a" * 40):
            path.write_text(json.dumps({"token": "another-owner"}))
        self.assertEqual(json.loads(path.read_text())["token"], "another-owner")

    def test_health_origin_cannot_send_requests_to_remote_or_userinfo(self):
        for bad in ("https://example.test:443", "http://example.test:3000", "http://user@localhost:3000", "http://localhost:3000/path", "http://localhost:3000?x=1", "http://localhost"):
            with self.subTest(origin=bad), self.assertRaises(RuntimeError):
                build.local_origin(bad)
        self.assertEqual(build.local_origin("http://localhost:3000/"), "http://localhost:3000")

    def test_source_cannot_escape_by_parent_or_symlink(self):
        repo = self.root / "repo"
        repo.mkdir()
        outside = self.root / "outside"
        outside.write_text("fixture")
        (repo / "link").symlink_to(outside)
        for name in ("../outside", str(outside), "link"):
            with self.subTest(path=name), self.assertRaises(RuntimeError):
                build.safe_source(repo, name)

    def test_credentials_are_not_accepted_as_source_payload(self):
        (self.root / ".env").write_text("fixture")
        with self.assertRaises(RuntimeError):
            build.safe_source(self.root, ".env")

    def migration_fixture(self):
        before = {"version": "7", "dialect": "postgresql", "entries": [{"idx": 282, "when": 100, "tag": "0282_current"}]}
        after = copy.deepcopy(before)
        after["entries"].append({"idx": 283, "when": 101, "tag": "0283_passkeys"})
        sql = "packages/db/migrations/0283_passkeys.sql"
        snapshot = "packages/db/migrations/meta/0283_snapshot.json"
        path = self.root / sql
        path.parent.mkdir(parents=True)
        path.write_text("CREATE TABLE passkeys (id text PRIMARY KEY);\n")
        changes = [("M", build.JOURNAL), ("A", sql), ("A", snapshot)]
        return before, after, changes

    def test_exact_migration_append_is_bound_to_sql_digest(self):
        before, after, changes = self.migration_fixture()
        result = build.check_migration(before, after, changes, self.root)
        self.assertEqual(result["tag"], "0283_passkeys")
        self.assertEqual(result["sqlSha256"], build.file_sha(self.root / result["sqlPath"]))

    def test_old_migration_rewrite_and_removed_history_rejected(self):
        before, after, changes = self.migration_fixture()
        with self.assertRaises(RuntimeError):
            build.check_migration(before, after, changes + [("M", "packages/db/migrations/0282_current.sql")], self.root)
        after["entries"][0]["when"] = 99
        with self.assertRaises(RuntimeError):
            build.check_migration(before, after, changes, self.root)

    def test_migration_cannot_reuse_old_index_or_timestamp(self):
        before, after, changes = self.migration_fixture()
        for key, bad in (("idx", 282), ("when", 100)):
            changed = copy.deepcopy(after)
            changed["entries"][-1][key] = bad
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                build.check_migration(before, changed, changes, self.root)

    def safety_fixture(self):
        candidate = {"revision": "a" * 40, "imageId": "sha256:" + "b" * 64,
                     "source": {"digest": "sha256:" + "c" * 64}, "migration": {"sqlSha256": "d" * 64},
                     "fallback": {"imageId": "sha256:" + "e" * 64, "source": {"digest": "sha256:" + "f" * 64}}}
        backup = self.root / "fixture.dump"
        backup.write_bytes(b"non-sensitive synthetic backup")
        stamp = datetime(2026, 11, 21, 20, 0, tzinfo=timezone.utc)
        evidence = {"schema": "ac-passkey-safety-v1", "revision": candidate["revision"], "imageId": candidate["imageId"],
                    "baseImageId": build.BASE, "sourceDigest": candidate["source"]["digest"],
                    "migrationSqlSha256": candidate["migration"]["sqlSha256"],
                    "backup": {"path": str(backup), "sha256": build.file_sha(backup), "completedAt": stamp.isoformat()}, "checks": {}}
        for name in activate.PROOF_NAMES:
            artifact = self.root / (name + ".json")
            artifact.write_text(json.dumps({"syntheticTest": True, "name": name}))
            evidence["checks"][name] = {"passed": True, "path": str(artifact), "sha256": build.file_sha(artifact)}
        evidence["checks"]["backupRestore"]["backupSha256"] = evidence["backup"]["sha256"]
        evidence["checks"]["oldAppCompatibility"].update(imageId=candidate["fallback"]["imageId"],
                                                         sourceDigest=candidate["fallback"]["source"]["digest"])
        path = self.root / "safety.json"
        path.write_text(json.dumps(evidence))
        return candidate, evidence, path, stamp

    def test_safety_proofs_require_matching_identity_and_backup(self):
        candidate, evidence, path, stamp = self.safety_fixture()
        activate.safety_evidence(path, candidate, current_time=stamp)
        evidence["imageId"] = "sha256:" + "e" * 64
        path.write_text(json.dumps(evidence))
        with self.assertRaises(RuntimeError):
            activate.safety_evidence(path, candidate, current_time=stamp)

    def test_safety_refuses_missing_old_app_compatibility(self):
        candidate, evidence, path, stamp = self.safety_fixture()
        evidence["checks"]["oldAppCompatibility"]["passed"] = False
        path.write_text(json.dumps(evidence))
        with self.assertRaises(RuntimeError):
            activate.safety_evidence(path, candidate, current_time=stamp)

    def test_original_image_is_not_a_compatible_fallback_proof(self):
        candidate, evidence, path, stamp = self.safety_fixture()
        evidence["checks"]["oldAppCompatibility"].update(imageId=build.BASE, sourceDigest=build.BASE_SOURCE["digest"])
        path.write_text(json.dumps(evidence))
        with self.assertRaisesRegex(RuntimeError, "tested fallback image"):
            activate.safety_evidence(path, candidate, current_time=stamp)

    def test_safety_refuses_modified_backup_or_proof_artifact(self):
        candidate, evidence, path, stamp = self.safety_fixture()
        proof = Path(evidence["checks"]["migrationRehearsal"]["path"])
        proof.write_text("changed")
        with self.assertRaises(RuntimeError):
            activate.safety_evidence(path, candidate, current_time=stamp)

    def test_backup_age_is_enforced_for_activation(self):
        candidate, _, path, stamp = self.safety_fixture()
        with self.assertRaises(RuntimeError):
            activate.safety_evidence(path, candidate, current_time=stamp + timedelta(hours=2))
        # Image rollback never restores that backup, so only its identity/proofs must remain intact.
        activate.safety_evidence(path, candidate, check_age=False, current_time=stamp + timedelta(hours=2))

    def test_restore_proof_must_name_exact_backup(self):
        candidate, evidence, path, stamp = self.safety_fixture()
        evidence["checks"]["backupRestore"]["backupSha256"] = "f" * 64
        path.write_text(json.dumps(evidence))
        with self.assertRaises(RuntimeError):
            activate.safety_evidence(path, candidate, current_time=stamp)

    def test_compose_cannot_inherit_host_or_file_overrides(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://unrelated:2375", "COMPOSE_FILE": "/unrelated.yml",
                                     "AGENTES_IMAGE": "other", "VALUE_IN_FILE": "override", "PATH": "/usr/bin"}, clear=True):
            environment = activate.compose_environment(b"AGENTES_IMAGE=expected\nVALUE_IN_FILE=file\n")
        self.assertEqual(environment, {"PATH": "/usr/bin"})

    def activation_fixture(self):
        instance = activate.Activation.__new__(activate.Activation)
        instance.candidate = {"revision": "a" * 40, "imageId": "sha256:" + "b" * 64,
                              "fallback": {"imageId": "sha256:" + "d" * 64, "source": {"digest": "sha256:" + "e" * 64}}}
        instance.env_path = self.root / ".env"
        original = b"AGENTES_IMAGE=" + build.BASE.encode() + b"\nKEEP=fixture\n"
        instance.env_path.write_bytes(original)
        instance.evidence = self.root
        instance.record_path = self.root / "activation.json"
        proof = self.root / "safety.json"
        proof.write_text("synthetic fixture")
        instance.args = SimpleNamespace(safety_evidence=proof, container="fixture")
        instance.docker = []
        instance.origin = "http://localhost:3000"
        instance.preflight = Mock(return_value=(original, {}))
        instance.compose_config = Mock(side_effect=lambda data: (None, None, activate.image_value(data).decode()))
        instance.containers = Mock()
        instance.idle = Mock(return_value={"executingRuns": 0, "machineWork": 0, "waitingInput": 1})
        instance.health = Mock(return_value={"status": "ok"})

        def up(_expected, _image, _allowed, record, phase, *_):
            record["state"] = phase + "-recreate-starting"
            instance.save(record)

        instance.up = Mock(side_effect=up)
        return instance, original, {"backup": {"sha256": "c" * 64}}

    def test_failed_post_activation_check_rolls_back_image_without_database_restore(self):
        instance, original, safety = self.activation_fixture()
        instance.verify_live = Mock(side_effect=RuntimeError("synthetic health failure"))
        with patch.object(activate.build, "inspect_live", return_value={}), self.assertRaises(RuntimeError):
            instance.activate(safety)
        self.assertEqual(instance.up.call_count, 2)
        self.assertEqual(instance.env_path.read_bytes(), activate.replace_image(original, instance.candidate["fallback"]["imageId"].encode()))
        record = json.loads(instance.record_path.read_text())
        self.assertEqual(record["state"], "rolled-back-to-compatible-app")
        self.assertIs(record["databaseRestorePerformed"], False)
        self.assertIs(record["additiveMigrationRetained"], True)

    def test_work_appearing_before_mutation_keeps_original_running_image(self):
        instance, original, safety = self.activation_fixture()
        instance.idle.side_effect = RuntimeError("new machine work")
        with patch.object(activate.build, "inspect_live", return_value={}), self.assertRaises(RuntimeError):
            instance.activate(safety)
        instance.up.assert_not_called()
        self.assertEqual(instance.env_path.read_bytes(), original)
        self.assertEqual(json.loads(instance.record_path.read_text())["state"], "aborted-before-recreate")

    def test_rollback_refuses_to_overwrite_concurrently_modified_configuration(self):
        instance, _, safety = self.activation_fixture()

        def failed_check():
            instance.env_path.write_bytes(instance.env_path.read_bytes() + b"ANOTHER_WRITER=new\n")
            raise RuntimeError("synthetic post-activation failure")

        instance.verify_live = Mock(side_effect=failed_check)
        with patch.object(activate.build, "inspect_live", return_value={}), self.assertRaises(RuntimeError):
            instance.activate(safety)
        self.assertEqual(instance.up.call_count, 1)
        self.assertIn(b"ANOTHER_WRITER=new", instance.env_path.read_bytes())
        self.assertEqual(json.loads(instance.record_path.read_text())["state"], "rollback-required")


if __name__ == "__main__":
    unittest.main()
