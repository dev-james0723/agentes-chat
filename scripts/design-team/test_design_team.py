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

if __name__ == "__main__":
    unittest.main()
