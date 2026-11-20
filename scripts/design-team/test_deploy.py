"""Regression tests for bounded, repeatable native design-team deployment."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

MODULE = Path(__file__).with_name("deploy.py")
spec = importlib.util.spec_from_file_location("design_deploy", MODULE)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ManagedBlockTests(unittest.TestCase):
    def test_append_and_repeat_preserve_original_bytes(self):
        original = "Existing instructions.  \r\n"
        once = deploy.merge_managed_block(original, "Role: designer")
        self.assertTrue(once.startswith(original))
        self.assertEqual(once, deploy.merge_managed_block(once, "Role: designer"))
        self.assertEqual(once.count(deploy.BEGIN), 1)

    def test_replacement_preserves_every_outside_byte(self):
        original = "PREFIX  \n" + deploy.BEGIN + "\nold\n" + deploy.END + "\nSUFFIX  "
        desired = deploy.merge_managed_block(original, "new")
        self.assertEqual(desired, "PREFIX  \n" + deploy.BEGIN + "\nnew\n" + deploy.END + "\nSUFFIX  ")

    def test_malformed_and_duplicate_sections_fail(self):
        for text in [deploy.BEGIN, deploy.END, deploy.END + deploy.BEGIN,
                     deploy.BEGIN + deploy.END + deploy.BEGIN + deploy.END]:
            with self.subTest(text=text), self.assertRaises(deploy.DeployError):
                deploy.merge_managed_block(text, "new")

    def test_concurrent_unrelated_instructions_are_remerged(self):
        old = deploy.merge_managed_block("original", "v1")
        fresh = old + "\nColleague's new instruction. "
        got = deploy.reconcile_instructions(old, fresh, "v2")
        self.assertTrue(got.endswith("\nColleague's new instruction. "))
        self.assertIn("\nv2\n", got)

    def test_concurrent_managed_section_change_aborts(self):
        old = deploy.merge_managed_block("original", "v1")
        fresh = deploy.merge_managed_block("original", "someone else's v3")
        with self.assertRaises(deploy.DeployError):
            deploy.reconcile_instructions(old, fresh, "v2")

    def test_legacy_scoped_update_is_idempotent_and_exact(self):
        adapter = {"mode": "scoped", "replacements": [{"old": "old policy", "new": "new policy"}]}
        result = deploy.apply_adapter("prefix old policy suffix", adapter)
        self.assertEqual(result, "prefix new policy suffix")
        self.assertEqual(result, deploy.apply_adapter(result, adapter))
        with self.assertRaises(deploy.DeployError):
            deploy.apply_adapter("old policy old policy", adapter)
        with self.assertRaises(deploy.DeployError):
            deploy.apply_adapter("unexpected policy", adapter)

    def test_legacy_appending_replacement_does_not_duplicate(self):
        adapter = {"mode": "scoped", "replacements": [{"old": "old", "new": "old plus new"}]}
        result = deploy.apply_adapter("prefix old suffix", adapter)
        self.assertEqual(deploy.apply_adapter(result, adapter), result)

    def test_remote_or_ambiguous_session_origins_are_rejected(self):
        for origin in ["https://example.com", "http://localhost.evil.test", "http://u@localhost",
                       "http://localhost/path", "http://localhost?next=evil", "file:///tmp/a"]:
            with self.subTest(origin=origin), self.assertRaises(deploy.DeployError):
                deploy.validate_origin(origin)
        self.assertEqual(deploy.validate_origin("http://localhost:3000"), "http://localhost:3000")


class FakeAPI:
    def __init__(self, agents):
        self.agents = {a["id"]: copy.deepcopy(a) for a in agents}
        self.skills = {}
        self.resources = {}
        self.assignments = {a["id"]: {"existing-skill": True} for a in agents}
        self.writes = []
        self.groups = [{"id": "group-test", "name": "Designer Team", "agentIds": list(self.agents)}]
        self.skills["existing-skill"] = self.skill("existing-skill", "existing", "Original legacy body")
        self.next_version = 0

    @staticmethod
    def skill(id_, name, body):
        return {"id": id_, "name": name, "body": body, "version": 1, "description": name,
                "metadata": {}, "files": [], "source": "upload", "locked": False,
                "defaultForNewAgents": False, "autoUpdate": False, "agentsImprove": False}

    def request(self, method, path, payload=None):
        from urllib.parse import unquote
        route, _, query = path.partition("?")
        parts = route.strip("/").split("/")
        if method != "GET":
            self.writes.append((method, route, copy.deepcopy(payload)))
        if route == "/agents" and method == "GET":
            return {"agents": copy.deepcopy(list(self.agents.values()))}
        if route == "/agent-groups" and method == "GET":
            return {"groups": copy.deepcopy(self.groups)}
        if route == "/skills" and method == "GET":
            return {"skills": copy.deepcopy(list(self.skills.values()))}
        if route == "/skills/import":
            raw = zipfile.ZipFile(io.BytesIO(base64.b64decode(payload["zipBase64"])))
            entries = {n: raw.read(n) for n in raw.namelist()}
            skill_md = entries.pop("SKILL.md").decode()
            name = deploy.parse_skill_markdown(skill_md)[0]
            existing = next((x for x in self.skills.values() if x["name"] == name), None)
            if existing and payload.get("createOnly"):
                raise deploy.DeployError("skill.name_taken")
            id_ = existing["id"] if existing else "new-native-skill"
            row = self.skill(id_, name, deploy.parse_skill_markdown(skill_md)[1])
            row["version"] = existing["version"] + 1 if existing else 1
            row["files"] = [{"path": n, "size": len(data),
                             "status": "script" if n.endswith(".py") else "stored",
                             "mime": "application/json" if n.endswith(".json") else "text/plain"}
                            for n, data in sorted(entries.items())]
            self.skills[id_] = row
            self.resources[id_] = entries
            return copy.deepcopy(row)
        if parts[0] == "skills" and len(parts) >= 2:
            row = self.skills[parts[1]]
            if len(parts) == 4 and parts[2] == "files":
                name = unquote(parts[3])
                return {"path": name, "version": row["version"],
                        "content": self.resources[parts[1]][name].decode(), "mime": "text/plain"}
            if method == "PATCH":
                row.update(payload)
                row["version"] += 1
            return copy.deepcopy(row)
        if parts[0] == "agents" and len(parts) >= 2:
            id_ = parts[1]
            if len(parts) == 2:
                if method == "PATCH":
                    self.agents[id_].update(payload)
                return copy.deepcopy(self.agents[id_])
            if parts[2] == "access":
                return {"all": True, "builtins": [{"scope": "sandbox:run", "state": "granted"}],
                        "connectors": []}
            if parts[2] == "brain":
                return {"configHash": "unchanged-config", "brain": "codex", "model": "kept-model"}
            if parts[2] == "skills":
                if method == "PUT":
                    for item in payload["skills"]:
                        self.assignments[id_][item["skillId"]] = item["enabled"]
                return {"skills": [dict(copy.deepcopy(row), enabled=self.assignments[id_].get(key, False))
                                   for key, row in self.skills.items()]}
        raise AssertionError((method, path, payload))


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.package = self.root / "package"
        (self.package / "references").mkdir(parents=True)
        (self.package / "scripts").mkdir()
        (self.package / "SKILL.md").write_text("---\nname: james-design-team\ndescription: Test skill\n---\nBody text.\n")
        (self.package / "scripts/design_team.py").write_text("print('self-check')\n")
        (self.package / "references/release.json").write_text('{"version":"1.0.0"}')
        self.roles = [{"id": f"role-{i}", "name": f"Designer {i}", "handle": f"designer-{i}",
                       "purpose": "Design work", "primaryCapabilities": ["frontend"]} for i in range(10)]
        (self.package / "references/roles.json").write_text(json.dumps({"roles": self.roles}))
        self.agents = [{"id": f"agent-{i}", "name": f"Designer {i}", "handle": f"designer-{i}",
                        "instructions": f"Original {i}.  ", "model": "kept-model", "role": "Designer",
                        "appearance": {"color": "blue"}, "ownerUserId": "owner"} for i in range(10)]
        self.api = FakeAPI(self.agents)
        self.config = {"orgId": "test-org", "group": {"id": "group-test", "name": "Designer Team"},
                       "snapshotDir": str(self.root / "private-snapshots"),
                       "agents": [dict(role=self.roles[i]["id"], **{k: a[k] for k in ["id", "name", "handle"]})
                                  for i, a in enumerate(self.agents)],
                       "legacySkills": [{"id": "existing-skill", "name": "existing"}]}
        self.adapters = {"existing": {"mode": "replace", "body": "Adapted local review body"}}

    def tearDown(self):
        self.temp.cleanup()

    def run_deploy(self, apply=False):
        return deploy.deploy(self.config, self.package, self.adapters, self.api, apply=apply)

    def test_default_dry_run_has_zero_api_writes(self):
        result = self.run_deploy()
        self.assertEqual(self.api.writes, [])
        self.assertEqual(result["mode"], "dry-run")
        self.assertEqual(result["agents"], 10)

    def test_apply_and_repeat_preserve_models_access_and_old_assignments(self):
        first = self.run_deploy(apply=True)
        self.assertEqual(first["mode"], "apply")
        self.assertTrue(self.api.writes)
        for method, path, body in self.api.writes:
            if path.startswith("/agents/") and method == "PATCH":
                self.assertEqual(set(body), {"instructions"})
            if path.endswith("/skills") and method == "PUT":
                self.assertEqual(body, {"skills": [{"skillId": "new-native-skill", "enabled": True}]})
        for a in self.agents:
            self.assertEqual(self.api.agents[a["id"]]["model"], a["model"])
            self.assertTrue(self.api.assignments[a["id"]]["existing-skill"])
            self.assertTrue(self.api.agents[a["id"]]["instructions"].startswith(a["instructions"]))
        version = self.api.skills["new-native-skill"]["version"]
        before = len(self.api.writes)
        self.run_deploy(apply=True)
        self.assertEqual(len(self.api.writes), before)
        self.assertEqual(self.api.skills["new-native-skill"]["version"], version)
        for path in (self.root / "private-snapshots").rglob("*.json"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_exact_identity_and_group_checked_before_any_write(self):
        self.api.agents["agent-0"]["name"] = "Unexpected replacement"
        with self.assertRaises(deploy.DeployError):
            self.run_deploy(apply=True)
        self.assertEqual(self.api.writes, [])

    def test_legacy_scope_requires_explicit_name_and_id(self):
        self.config["legacySkills"] = []
        with self.assertRaises(deploy.DeployError):
            self.run_deploy(apply=True)
        self.assertEqual(self.api.writes, [])

    def test_package_hash_and_zip_are_deterministic_and_exclude_main_resource(self):
        one = deploy.prepare_bundle(self.package)
        (self.package / ".private").write_text("not included")
        (self.package / "__pycache__").mkdir()
        (self.package / "__pycache__/cache.pyc").write_bytes(b"ignored")
        two = deploy.prepare_bundle(self.package)
        self.assertEqual(one["zipBase64"], two["zipBase64"])
        self.assertNotIn("SKILL.md", one["release"]["files"])
        self.assertNotIn("references/release.json", one["release"]["files"])
        encoded = json.dumps(one["release"]["files"], sort_keys=True, separators=(",", ":")).encode()
        self.assertEqual(one["release"]["digest"], hashlib.sha256(encoded).hexdigest())
        self.assertEqual(one["release"]["bodySha256"], hashlib.sha256(b"Body text.").hexdigest())
        (self.package / "SKILL.md").write_text("---\nname: james-design-team\ndescription: Test skill\n---\nChanged body.\n")
        three = deploy.prepare_bundle(self.package)
        self.assertEqual(one["release"]["digest"], three["release"]["digest"])
        self.assertNotEqual(one["release"]["bodySha256"], three["release"]["bodySha256"])

    def test_body_only_change_imports_new_version_once(self):
        self.run_deploy(apply=True)
        before = self.api.skills["new-native-skill"]["version"]
        (self.package / "SKILL.md").write_text("---\nname: james-design-team\ndescription: Test skill\n---\nBody v2.\n")
        self.run_deploy(apply=True)
        self.assertEqual(self.api.skills["new-native-skill"]["version"], before + 1)
        self.run_deploy(apply=True)
        self.assertEqual(self.api.skills["new-native-skill"]["version"], before + 1)

    def test_private_snapshots_inside_a_git_checkout_are_rejected(self):
        (self.root / ".git").mkdir()
        with self.assertRaises(deploy.DeployError):
            self.run_deploy(apply=True)
        self.assertEqual(self.api.writes, [])


if __name__ == "__main__":
    unittest.main()
