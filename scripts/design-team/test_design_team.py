"""Behavior tests for the native design-team planner and delivery contract."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
PACK = ROOT / "examples/skills/james-design-team"
CORE = PACK / "scripts/team_core.py"

class PlannerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = None
        if CORE.exists():
            spec = importlib.util.spec_from_file_location("team_core", CORE)
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)

    def setUp(self):
        self.assertIsNotNone(self.module, "Executable design planner is not implemented")
        self.catalog = json.loads((PACK / "references/capabilities.json").read_text())
        self.roles = json.loads((PACK / "references/roles.json").read_text())

    def request(self, **changes):
        data = {"taskId": "test-01", "brand": "Quick Track", "surface": "web",
                "brief": "Improve a settings page", "languages": ["en"],
                "deliverables": ["implementation", "preview"]}
        data.update(changes)
        return data

    def plan(self, **changes):
        return self.module.plan_task(self.request(**changes), self.catalog, self.roles)

    def ids(self, plan):
        return [x["id"] for x in plan["selectedCapabilities"]]

    def test_same_brand_obeys_explicit_platform(self):
        web = self.plan(stack="react")
        native = self.plan(surface="native", stack="swiftui")
        self.assertEqual(web["brand"], native["brand"])
        self.assertIn("frontend", self.ids(web))
        self.assertNotIn("native-ui", self.ids(web))
        self.assertIn("native-ui", self.ids(native))
        self.assertNotIn("frontend", self.ids(native))
        self.assertNotIn("motion-foundations", native["selectedSkills"])

    def test_social_preserves_languages_formats_and_responsibility(self):
        result = self.plan(brand="D Festival", surface="social",
                           languages=["zh-HK", "en"], deliverables=["carousel", "story"])
        self.assertEqual(result["languages"], ["zh-HK", "en"])
        self.assertEqual(result["requiredDeliverables"], ["carousel", "story"])
        self.assertEqual(result["owner"], "isabella")
        self.assertEqual(result["reviewer"], "lily")
        self.assertEqual(result["coordinator"], "oliver")
        self.assertIn("hk-bilingual", self.ids(result))
        self.assertIn("emma", result["collaborators"])

    def test_small_fix_does_not_trigger_strategy_workshop(self):
        result = self.plan(scope="small", brief="Fix the spacing on this existing page")
        self.assertNotIn("research", self.ids(result))
        self.assertNotIn("art-direction", self.ids(result))
        self.assertNotIn("brand-discovery", result["selectedSkills"])
        self.assertIn("frontend", self.ids(result))

    def test_explicit_skill_remains_discoverable(self):
        result = self.plan(requestedSkills=["custom-specialist", "frontend-design"])
        self.assertIn("custom-specialist", result["selectedSkills"])
        self.assertEqual(result["selectedSkills"].count("frontend-design"), 1)
        self.assertTrue(any("custom-specialist" in w for w in result["warnings"]))

    def test_context_isolated_and_current_override_wins(self):
        contexts = {"dfestival": {"brandId": "dfestival", "palette": "GREEN", "examples": ["FESTIVAL"]},
                    "quicktrack": {"brandId": "quicktrack", "palette": "BLUE", "examples": ["PRODUCT"]}}
        a = self.plan(brand="D Festival", brandContexts=contexts, overrides={"palette": "RED"})
        b = self.plan(brand="Quick Track", brandContexts=contexts)
        self.assertEqual(a["brandContext"]["palette"], "RED")
        self.assertEqual(b["brandContext"]["palette"], "BLUE")
        self.assertNotIn("PRODUCT", json.dumps(a["brandContext"]))
        self.assertNotIn("FESTIVAL", json.dumps(b["brandContext"]))

    def test_unknown_brand_has_no_invented_identity(self):
        result = self.plan(brand="New Studio")
        self.assertEqual(result["brand"], "new-studio")
        self.assertNotIn("palette", result["brandContext"])
        self.assertTrue(result["warnings"])

    def test_explicit_author_still_has_independent_reviewer(self):
        result = self.plan(owner="lily")
        self.assertEqual(result["owner"], "lily")
        self.assertNotEqual(result["owner"], result["reviewer"])

    def test_unknown_surface_is_explicit_error(self):
        with self.assertRaises(ValueError):
            self.plan(surface="unsupported-platform")

# Delivery validation cases follow.


class DeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("team_core", CORE)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def setUp(self):
        import tempfile
        import struct
        import zlib
        self.assertTrue(hasattr(self.module, "validate_delivery"),
                        "Delivery validator is not implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        def chunk(name, data):
            return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))
        png = (b"\x89PNG\r\n\x1a\n" +
               chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)) +
               chunk(b"IDAT", zlib.compress(b"\x00" + b"\xff\x00\x00" * 2 + b"\x00" + b"\xff\x00\x00" * 2)) +
               chunk(b"IEND", b""))
        for name in ["carousel.png", "story.png"]:
            (self.workspace / name).write_bytes(png)
        (self.workspace / "source.html").write_text("<h1>TEST 測試</h1>")
        self.plan = {"taskId": "test-02", "brand": "dfestival", "surface": "social",
                     "owner": "isabella", "reviewer": "lily",
                     "requiredDeliverables": ["editable-source", "carousel", "story"]}
        self.manifest = {
            "status": "rendered", "contentVersion": "fixture-v1",
            "artifacts": [
                {"deliverable": "editable-source", "path": "source.html", "contentVersion": "fixture-v1"},
                {"deliverable": "carousel", "path": "carousel.png", "contentVersion": "fixture-v1"},
                {"deliverable": "story", "path": "story.png", "contentVersion": "fixture-v1"}],
            "review": {"reviewerId": "lily", "result": "pass", "platform": "social",
                       "contentVersion": "fixture-v1",
                       "evidence": ["source.html", "carousel.png", "story.png"], "findings": []}}
    def validate(self):
        return self.module.validate_delivery(self.plan, self.manifest, self.workspace)

    def test_real_files_and_independent_zero_issue_review_can_pass(self):
        result = self.validate()
        self.assertTrue(result["verified"], result)
        self.assertEqual(result["state"], "rendered")

    def test_missing_required_visual_cannot_be_text_only_complete(self):
        (self.workspace / "story.png").unlink()
        self.assertFalse(self.validate()["verified"])

    def test_image_prompt_cannot_replace_visual_export(self):
        (self.workspace / "story.png").write_text("Generate an attractive story image.")
        self.assertFalse(self.validate()["verified"])

    def test_truncated_png_is_not_recognized_export(self):
        (self.workspace / "story.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        self.assertFalse(self.validate()["verified"])

    def test_artifact_version_mismatch_fails(self):
        self.manifest["artifacts"][1]["contentVersion"] = "old"
        self.assertFalse(self.validate()["verified"])

    def test_review_for_old_version_fails(self):
        self.manifest["review"]["contentVersion"] = "old"
        self.assertFalse(self.validate()["verified"])

    def test_path_escape_fails_even_when_file_exists(self):
        self.manifest["artifacts"][1]["path"] = str(CORE)
        self.assertFalse(self.validate()["verified"])

    def test_symlink_escape_is_rejected(self):
        (self.workspace / "outside.png").symlink_to(CORE)
        self.manifest["artifacts"][1]["path"] = "outside.png"
        self.assertFalse(self.validate()["verified"])

    def test_self_review_cannot_pass(self):
        self.manifest["review"]["reviewerId"] = "isabella"
        self.assertFalse(self.validate()["verified"])

    def test_review_must_cover_all_required_artifacts(self):
        self.manifest["review"]["evidence"] = ["carousel.png"]
        self.assertFalse(self.validate()["verified"])

    def test_web_review_is_not_native_evidence(self):
        self.plan["surface"] = "native"
        self.manifest["review"]["platform"] = "web"
        self.assertFalse(self.validate()["verified"])

    def test_published_without_readback_stays_unverified(self):
        self.manifest["status"] = "published"
        result = self.validate()
        self.assertFalse(result["verified"])
        self.assertEqual(result["state"], "unverified")
        self.assertEqual(result["nextAction"], "read_back_before_retry")

    def test_matching_publication_receipt_is_validated_as_supplied_evidence(self):
        self.manifest["status"] = "published"
        fields = {"accountId": "test-account", "channel": "instagram", "postId": "test-post",
                  "permalink": "https://example.invalid/posts/test-post", "contentVersion": "fixture-v1"}
        self.manifest["publication"] = dict(fields, readback=dict(fields, confirmed=True))
        result = self.validate()
        self.assertTrue(result["verified"], result)
        self.assertEqual(result["state"], "published")
        self.assertIn("supplied", result["evidenceScope"])

    def test_mismatched_account_readback_cannot_verify_publication(self):
        self.manifest["status"] = "published"
        fields = {"accountId": "test-account", "channel": "instagram", "postId": "test-post",
                  "permalink": "https://example.invalid/posts/test-post", "contentVersion": "fixture-v1"}
        self.manifest["publication"] = dict(fields, readback=dict(fields, confirmed=True))
        self.manifest["publication"]["readback"]["accountId"] = "another-account"
        self.assertEqual(self.validate()["state"], "unverified")

    def test_scheduled_remains_distinct_from_published(self):
        self.manifest["status"] = "scheduled"
        fields = {"accountId": "test-account", "channel": "instagram", "jobId": "job-01",
                  "scheduledAt": "2026-11-21T12:00:00Z", "contentVersion": "fixture-v1"}
        self.manifest["publication"] = dict(fields, readback=dict(fields, confirmed=True))
        result = self.validate()
        self.assertTrue(result["verified"], result)
        self.assertEqual(result["state"], "scheduled")

    def test_ambiguous_publication_requires_readback_not_retry(self):
        self.manifest["status"] = "unverified"
        result = self.validate()
        self.assertFalse(result["verified"])
        self.assertEqual(result["nextAction"], "read_back_before_retry")

    def test_draft_is_not_completed(self):
        self.manifest["status"] = "draft"
        result = self.validate()
        self.assertFalse(result["verified"])
        self.assertEqual(result["state"], "draft")

    def test_publication_identity_changes_for_account_or_content(self):
        fields = {"accountId": "a", "channel": "instagram", "taskId": "t", "contentVersion": "v1"}
        key = self.module.publication_key(fields)
        self.assertEqual(key, self.module.publication_key(dict(reversed(list(fields.items())))))
        self.assertNotEqual(key, self.module.publication_key(dict(fields, accountId="b")))
        self.assertNotEqual(key, self.module.publication_key(dict(fields, contentVersion="v2")))


    def test_cli_reports_success_incomplete_and_invalid_input(self):
        import subprocess
        import sys
        cli = PACK / "scripts/design_team.py"
        request_file = self.workspace / "validation.json"
        request_file.write_text(json.dumps({"plan": self.plan, "manifest": self.manifest}))
        command = [sys.executable, str(cli), "validate", "--input", str(request_file),
                   "--workspace", str(self.workspace)]
        valid = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(valid.returncode, 0, valid.stdout + valid.stderr)
        (self.workspace / "story.png").unlink()
        incomplete = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(incomplete.returncode, 1, incomplete.stdout + incomplete.stderr)
        invalid = subprocess.run([sys.executable, str(cli), "plan", "--request-json", "{"],
                                 capture_output=True, text=True)
        self.assertEqual(invalid.returncode, 2)
        self.assertIn("error", json.loads(invalid.stdout))

    def test_publication_key_is_available_to_native_cli(self):
        import subprocess
        import sys
        fields = {"accountId": "a", "channel": "instagram", "taskId": "t", "contentVersion": "v1"}
        result = subprocess.run([sys.executable, str(PACK / "scripts/design_team.py"),
                                 "publication-key", "--request-json", json.dumps(fields)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["key"], self.module.publication_key(fields))

if __name__ == "__main__":
    unittest.main()

