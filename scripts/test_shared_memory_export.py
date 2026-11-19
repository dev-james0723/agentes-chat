"""Focused offline safety/behavior checks for the native file export bridge."""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request


SPEC = importlib.util.spec_from_file_location("shared_memory_export", Path(__file__).with_name("shared-memory-export.py"))
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)
ORG = "00000000-0000-4000-8000-000000000001"


def record(key="preference", content="Keep release notes concise.", status="active"):
    return {"id": key, "key": key, "title": key, "content": content, "status": status, "itemId": "native-" + key, "itemVersion": 2, "readable": True, "blockedReason": None, "version": 2, "forgottenAt": None, "history": [{"content": "OLD HISTORY MUST NOT LEAK"}]}


def page(entries=None, *, version=7, cursor=None, total=None, candidates=None):
    entries = entries if entries is not None else [record()]
    candidates = candidates or []
    return {
        "profile": {"id": "profile-one", "version": version, "availabilityRevision": "a" * 64},
        "canManage": True,
        "entries": entries,
        "candidates": candidates,
        "sources": [{"id": "source-one", "name": "Review notes", "coverage": "All 12 source records read", "capturedAt": "2026-01-01T00:00:00Z", "status": "snapshot"}],
        "pagination": {"complete": cursor is None, "nextCursor": cursor, "total": len(entries) + len(candidates) if total is None else total},
    }


class FakeApi:
    def __init__(self, pages, before_receipt=None):
        self.pages = iter(pages)
        self.calls = []
        self.before_receipt = before_receipt

    def request(self, suffix="", *, query=None, body=None):
        self.calls.append((suffix, query, copy.deepcopy(body)))
        if body:
            if self.before_receipt:
                self.before_receipt()
            return {"action": {"state": "applied"}, "snapshot": {"consumers": [body["consumer"]]}}
        return copy.deepcopy(next(self.pages))


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_paginated_scan_is_complete_and_version_pinned(self):
        one = page([record("one")], cursor="next", total=2)
        two = page([record("two")], total=2)
        api = FakeApi([one, two, one])
        result = bridge.read_snapshot(api)
        self.assertEqual([entry["id"] for entry in result["entries"]], ["one", "two"])
        self.assertEqual(api.calls[1][1]["cursor"], "next")
        self.assertEqual(api.calls[-1][1], {"limit": 1})

    def test_revision_or_provenance_change_rejects_before_write(self):
        for kind in ("version", "source", "availability", "final", "final_availability"):
            with self.subTest(kind=kind):
                one = page([record("one")], cursor="next", total=2)
                two = page([record("two")], total=2)
                final = copy.deepcopy(one)
                if kind == "version":
                    two["profile"]["version"] = 8
                elif kind == "source":
                    two["sources"][0]["coverage"] = "Changed"
                elif kind == "availability":
                    two["profile"]["availabilityRevision"] = "b" * 64
                elif kind == "final_availability":
                    final["profile"]["availabilityRevision"] = "b" * 64
                else:
                    final["profile"]["version"] = 8
                target = self.root / "MEM-CORE.md"
                target.write_bytes(b"previous verified export")
                with self.assertRaises(bridge.ExportError):
                    bridge.export(FakeApi([one, two, final]), self.root, "MEM", "core")
                self.assertEqual(target.read_bytes(), b"previous verified export")

    def test_missing_repeated_or_non_advancing_pages_fail_closed(self):
        cases = [
            [page(total=2)],
            [page(cursor="next", total=2), page(total=2)],
            [page(cursor="next", total=3), page([record("two")], cursor="next", total=3)],
            [{**page(), "canManage": False}],
        ]
        for pages in cases:
            with self.subTest(pages=len(pages)), self.assertRaises(bridge.ExportError):
                bridge.read_snapshot(FakeApi(pages))

    def test_exports_only_active_content_preserves_coverage_and_exact_core(self):
        core = "Concise replies. 保留來源。\nNo automatic new permissions."
        data = page([record("core", core), record("forgotten", "FORGOTTEN SECRET", "forgotten"), record("rejected", "REJECTED SECRET", "rejected")], candidates=[record("candidate", "CANDIDATE SECRET", "candidate")])
        result = bridge.export(FakeApi([data, data]), self.root, "MEM", "core")
        self.assertEqual((self.root / "MEM-CORE.md").read_bytes(), core.encode())
        for name in ("MEM-MEMORY.md", "CLAUDE-IMPORT.md"):
            text = (self.root / name).read_text()
            self.assertIn(core, text)
            self.assertIn("All 12 source records read", text)
            for absent in ("FORGOTTEN SECRET", "REJECTED SECRET", "CANDIDATE SECRET", "OLD HISTORY MUST NOT LEAK"):
                self.assertNotIn(absent, text)
        for item in self.root.iterdir():
            self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600)
        self.assertEqual(result["activeCount"], 1)

    def test_vanished_core_is_overwritten_with_empty_bytes(self):
        target = self.root / "MEM-CORE.md"
        target.write_bytes(b"previous core must disappear")
        data = page()
        result = bridge.export(FakeApi([data, data]), self.root, "MEM", "missing-core")
        self.assertEqual(target.read_bytes(), b"")
        self.assertFalse(result["corePresent"])

    def test_withdrawn_source_is_omitted_and_clears_a_previously_exported_core(self):
        (self.root / "MEM-CORE.md").write_bytes(b"previous core")
        withdrawn = {**record("core", "WITHDRAWN SOURCE MUST NOT LEAK"), "readable": False, "blockedReason": "Source withdrawn", "itemId": None, "itemVersion": None}
        data = page([withdrawn])
        result = bridge.export(FakeApi([data, data]), self.root, "MEM", "core")
        self.assertEqual((self.root / "MEM-CORE.md").read_bytes(), b"")
        self.assertEqual((result["activeCount"], result["unavailableCount"]), (0, 1))
        text = (self.root / "MEM-MEMORY.md").read_text()
        self.assertNotIn("WITHDRAWN SOURCE MUST NOT LEAK", text)
        self.assertIn("Unavailable active memories omitted: 1", text)

    def test_incomplete_readability_contract_never_overwrites_existing_files(self):
        target = self.root / "MEM-CORE.md"
        target.write_bytes(b"previous verified export")
        for field in ("readable", "itemVersion"):
            data = page()
            del data["entries"][0][field]
            with self.subTest(field=field), self.assertRaises(bridge.ExportError):
                bridge.export(FakeApi([data, data]), self.root, "MEM", "core")
            self.assertEqual(target.read_bytes(), b"previous verified export")

    def test_overlong_core_never_gets_truncated_or_partially_written(self):
        data = page([record("core", "界" * 601)])
        with self.assertRaisesRegex(bridge.ExportError, "exceeds 600"):
            bridge.export(FakeApi([data, data]), self.root, "MEM", "core")
        self.assertFalse((self.root / "MEM-CORE.md").exists())

    def test_file_receipt_is_specific_and_requires_exact_reread(self):
        data = page()
        api = FakeApi([data, data, data])
        result = bridge.export(api, self.root, "MEM", "core", record_receipt=True)
        consumer = api.calls[-1][2]["consumer"]
        self.assertEqual((consumer["kind"], consumer["status"], consumer["revision"], consumer["writable"]), ("file", "current", 7, False))
        self.assertEqual(consumer["availabilityRevision"], "a" * 64)
        self.assertIn("no native provider import or agent retrieval", consumer["reason"])
        self.assertEqual(result["receipt"], "file_only_confirmed")
        changed = page(version=8)
        api = FakeApi([data, data, changed])
        with self.assertRaisesRegex(bridge.ExportError, "no current file receipt"):
            bridge.export(api, self.root, "MEM", "core", record_receipt=True)
        self.assertFalse(any(call[2] for call in api.calls))
        changed = page()
        changed["profile"]["availabilityRevision"] = "b" * 64
        api = FakeApi([data, data, changed])
        with self.assertRaisesRegex(bridge.ExportError, "no current file receipt"):
            bridge.export(api, self.root, "MEM", "core", record_receipt=True)
        self.assertFalse(any(call[2] for call in api.calls))
        api = FakeApi([data, data, data])
        real_verify = bridge.verify_files
        checks = []

        def tamper(directory, files):
            checks.append(1)
            if len(checks) == 2:
                (self.root / "MEM-CORE.md").write_bytes(b"tampered")
            return real_verify(directory, files)

        with mock.patch.object(bridge, "verify_files", tamper), self.assertRaises(bridge.ExportError):
            bridge.export(api, self.root, "MEM", "core", record_receipt=True)
        self.assertFalse(any(call[2] for call in api.calls))

    def test_lock_and_private_directory_requirements(self):
        with bridge.output_lock(self.root), self.assertRaisesRegex(bridge.ExportError, "already"):
            with bridge.output_lock(self.root):
                self.fail("lock unexpectedly acquired")
        self.root.chmod(0o755)
        with self.assertRaisesRegex(bridge.ExportError, "0700"):
            with bridge.output_lock(self.root):
                self.fail("public directory accepted")

    def test_atomic_failure_leaves_previous_file_and_removes_temporary(self):
        (self.root / "MEM-CORE.md").write_bytes(b"old")
        with bridge.output_lock(self.root) as directory:
            with mock.patch.object(bridge.os, "replace", side_effect=OSError("synthetic failure")), self.assertRaises(OSError):
                bridge.atomic_write(directory, "MEM-CORE.md", b"new")
        self.assertEqual((self.root / "MEM-CORE.md").read_bytes(), b"old")
        self.assertFalse(list(self.root.glob("*.tmp")))

    def test_cookie_is_private_single_line_and_not_a_symlink(self):
        cookie = self.root / "cookie"
        cookie.write_bytes(b"session=private-test-value\n")
        cookie.chmod(0o600)
        self.assertEqual(bridge.read_cookie(cookie), "session=private-test-value")
        cookie.chmod(0o644)
        with self.assertRaises(bridge.ExportError):
            bridge.read_cookie(cookie)
        cookie.chmod(0o600)
        cookie.write_bytes(b"session=test\nInjected: value")
        with self.assertRaises(bridge.ExportError):
            bridge.read_cookie(cookie)
        alias = self.root / "alias"
        alias.symlink_to(cookie)
        with self.assertRaises(bridge.ExportError):
            bridge.read_cookie(alias)

    def test_existing_netscape_jar_is_not_rewritten_and_scopes_headers(self):
        jar_path = self.root / "owner.cookies"
        original = b"# Netscape HTTP Cookie File\napp.example\tFALSE\t/api/app\tTRUE\t2147483647\tsession\tprivate-test-value\nother.example\tFALSE\t/\tTRUE\t2147483647\tother\tunrelated-test-value\n"
        jar_path.write_bytes(original)
        jar_path.chmod(0o600)
        jar = bridge.read_cookie_jar(jar_path)
        allowed = urllib.request.Request("https://app.example/api/app/organizations/x/shared-memory")
        jar.add_cookie_header(allowed)
        self.assertEqual(allowed.get_header("Cookie"), "session=private-test-value")
        for url in ("https://elsewhere.example/api/app", "https://sub.app.example/api/app", "https://app.example/not-api", "http://app.example/api/app"):
            denied = urllib.request.Request(url)
            jar.add_cookie_header(denied)
            self.assertIsNone(denied.get_header("Cookie"))
        self.assertEqual(jar_path.read_bytes(), original)
        with mock.patch.object(urllib.request, "build_opener") as build:
            bridge.Api("https://app.example", ORG, cookie_jar=jar)
        self.assertIs(build.call_args.args[2].cookiejar, jar)
        jar_path.write_bytes(original.replace(b"2147483647", b"DO_NOT_PRINT"))
        output = io.StringIO()
        with contextlib.redirect_stderr(output), self.assertRaises(bridge.ExportError):
            bridge.read_cookie_jar(jar_path)
        self.assertEqual(output.getvalue(), "")

    def test_origin_redirect_and_proxy_boundaries(self):
        for invalid in ("http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?secret=1", "file:///tmp/x", "http://127.0.0.1.evil.example"):
            with self.subTest(origin=invalid), self.assertRaises(bridge.ExportError):
                bridge.origin(invalid)
        self.assertEqual(bridge.origin("http://[::1]:3000/"), "http://[::1]:3000")
        self.assertEqual(bridge.origin("http://localhost:3000"), "http://localhost:3000")
        with self.assertRaises(bridge.ExportError):
            bridge.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.example")
        with mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://proxy.example"}), mock.patch.object(urllib.request, "build_opener") as build:
            bridge.Api("https://app.example", ORG, "session=test")
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], bridge.NoRedirect)

    def test_auth_error_does_not_echo_credentials_or_response(self):
        api = bridge.Api("https://app.example", ORG, "session=DO_NOT_PRINT")
        api.opener = mock.Mock()
        api.opener.open.side_effect = urllib.error.HTTPError("https://app.example", 403, "DO_NOT_PRINT", {}, io.BytesIO(b"private body"))
        with self.assertRaises(bridge.ExportError) as caught:
            api.request()
        self.assertNotIn("DO_NOT_PRINT", str(caught.exception))
        self.assertNotIn("private body", str(caught.exception))
        self.assertEqual(api.opener.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
