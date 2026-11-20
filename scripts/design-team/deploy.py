#!/usr/bin/env python3
"""Deploy the native design-team package with bounded, checked API updates.

Dry-run is the default. Credentials and immutable before/after snapshots stay
outside Git. The native API has no CAS: fresh comparisons detect observed
conflicts but cannot eliminate a write between the final read and PATCH.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

BEGIN = "<!-- james-design-team:begin -->"
END = "<!-- james-design-team:end -->"
SKILL_NAME = "james-design-team"
RELEASE_PATH = "references/release.json"
REPO = Path(__file__).resolve().parents[2]
DETAIL_FIELDS = (
    "id", "name", "handle", "role", "model", "ownerUserId", "credentialId",
    "monthlyBudgetUsd", "defaultBudgetUsd", "audience", "audienceMode",
    "canTalk", "appearance", "mediaReplies", "createdAt",
)
SKILL_FIELDS = (
    "id", "name", "description", "body", "version", "metadata", "files",
    "source", "sourceUrl", "sourceVia", "defaultForNewAgents", "locked",
    "autoUpdate", "agentsImprove", "origin", "ownerAgentId",
)


class DeployError(Exception):
    """A safe, bounded deployment failure."""


class APIError(DeployError):
    def __init__(self, status, method, path):
        self.status = status
        super().__init__(f"HTTP {status} for {method} {path}; response body withheld")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def object_hash(value):
    return sha256(canonical(value).encode())


def selected(value, fields):
    return {key: value.get(key) for key in fields}


def _section(text):
    if not isinstance(text, str):
        raise DeployError("Instructions must be text")
    starts, ends = text.count(BEGIN), text.count(END)
    if starts == ends == 0:
        return None
    if starts != 1 or ends != 1 or text.index(BEGIN) > text.index(END):
        raise DeployError("Malformed or duplicate design-team managed block")
    return text[text.index(BEGIN):text.index(END) + len(END)]


def merge_managed_block(text, block):
    """Replace only the managed span; every outside byte is retained."""
    previous = _section(text)
    if not isinstance(block, str) or BEGIN in block or END in block:
        raise DeployError("Managed content must not contain marker delimiters")
    desired = BEGIN + "\n" + block.rstrip("\n") + "\n" + END
    if previous is not None:
        at = text.index(BEGIN)
        return text[:at] + desired + text[at + len(previous):]
    separator = "" if not text or text.endswith("\n\n") else "\n" if text.endswith("\n") else "\n\n"
    return text + separator + desired


def reconcile_instructions(snapshot, fresh, block):
    """Re-merge outside edits; refuse an unrecognized concurrent managed edit."""
    old_section, fresh_section = _section(snapshot), _section(fresh)
    desired_section = _section(merge_managed_block("", block))
    if fresh_section != old_section and fresh_section != desired_section:
        raise DeployError("Managed instructions changed concurrently; no stale overwrite")
    merged = merge_managed_block(fresh, block)
    if len(merged) > 50_000:
        raise DeployError("Managed instructions would exceed the native 50000-character limit")
    return merged


def role_block(role):
    capabilities = ", ".join(role.get("primaryCapabilities", []))
    return (
        f"## James Designer Team — {role['name']}\n"
        f"Role key: {role['id']}. Purpose: {role['purpose']}\n"
        f"Primary capabilities: {capabilities}.\n"
        f"For design tasks, load_skill {SKILL_NAME}. Use its native run_skill_script "
        "with scripts/design_team.py plan and a structured brief to select the task owner, "
        "reviewer, capabilities, scoped brand context and references. Read only the selected references. "
        "Keep explicitly requested skills available; this layer does not grant or remove tool access.\n"
        "The current user request and explicit platform/stack override stored taste. "
        "Preserve requested languages, formats and brand boundaries. Use the plan's coordinator "
        "and independent reviewer; do not add another coordinator or approve your own production work.\n"
        "Run the package validator against actual files and review evidence. "
        "An image/video prompt or a claim of execution is not an exported asset or a tool receipt. "
        "Use draft, rendered, scheduled, published, failed or unverified accurately. "
        "Publish only when authorized; verify ambiguous publication before retrying. "
        "Continue already authorized reversible work without repeated confirmation."
    )


def apply_adapter(body, adapter):
    if adapter.get("mode") == "replace":
        replacement = adapter.get("body")
        if not isinstance(replacement, str) or not replacement.strip():
            raise DeployError("A replacement adapter needs a nonempty body")
        return replacement
    if adapter.get("mode") != "scoped" or not adapter.get("replacements"):
        raise DeployError("A legacy adapter must be replace or scoped")
    result = body
    for item in adapter["replacements"]:
        old, new = item.get("old"), item.get("new")
        if not isinstance(old, str) or not old or not isinstance(new, str) or not new:
            raise DeployError("A scoped replacement needs nonempty exact old/new text")
        if old == new:
            continue
        # A replacement may contain its old phrase; count only one applied span.
        if result.count(new) == 1 and result.count(old) == new.count(old):
            continue
        if result.count(new) or result.count(old) != 1:
            raise DeployError("Legacy scoped replacement no longer matches exactly once")
        result = result.replace(old, new, 1)
    return result


def validate_origin(origin):
    if not isinstance(origin, str):
        raise DeployError("Session origin must be a localhost URL")
    try:
        parsed = urllib.parse.urlsplit(origin)
        port = parsed.port
    except ValueError:
        raise DeployError("Invalid localhost session origin") from None
    if (parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1")
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise DeployError("Session origin must be localhost or 127.0.0.1 with no path or credentials")
    suffix = f":{port}" if port is not None else ""
    return f"{parsed.scheme}://{parsed.hostname}{suffix}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise DeployError("Redirect refused; credentials were not forwarded")


class NativeAPI:
    def __init__(self, config, allow_writes=False):
        try:
            session = json.loads(Path(config["sessionFile"]).expanduser().read_text())
            self.origin = validate_origin(session["origin"])
            self._cookie = session["cookie"]
            if not isinstance(self._cookie, str) or not self._cookie or "\n" in self._cookie or "\r" in self._cookie:
                raise DeployError("Invalid local session cookie")
            uuid.UUID(config["orgId"])
        except (KeyError, ValueError, OSError):
            raise DeployError("Could not load a valid private local session and organization") from None
        if config.get("origin") and validate_origin(config["origin"]) != self.origin:
            raise DeployError("Configured origin does not match the signed-in session")
        self.base = self.origin + "/api/app/organizations/" + config["orgId"]
        self.allow_writes = allow_writes
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, payload=None):
        if not path.startswith("/") or path.startswith("//") or "\r" in path or "\n" in path:
            raise DeployError("Invalid organization-relative API route")
        if method != "GET" and not self.allow_writes:
            raise DeployError("API mutation blocked in dry-run mode")
        body = None if payload is None else canonical(payload).encode()
        request = urllib.request.Request(
            self.base + path, data=body, method=method,
            headers={"Cookie": self._cookie, "Origin": self.origin,
                     "Accept": "application/json", "Content-Type": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=40) as response:
                if response.status == 204:
                    return None
                raw = response.read(24 * 1024 * 1024 + 1)
                if len(raw) > 24 * 1024 * 1024:
                    raise DeployError("Native API response exceeded the bounded reader")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raise APIError(error.code, method, path) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise DeployError(f"Native API {method} failed; check state before retrying any write") from None
        except (ValueError, UnicodeError):
            raise DeployError("Native API returned invalid JSON; response body withheld") from None


def parse_skill_markdown(text):
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)(.*)\Z", text, re.S)
    if not match:
        raise DeployError("SKILL.md needs YAML frontmatter")
    name_match = re.search(r"(?m)^name:\s*([^\r\n]+)", match.group(1))
    if not name_match:
        raise DeployError("SKILL.md needs an explicit name")
    name = name_match.group(1).strip().strip("'\"")
    if name != SKILL_NAME:
        raise DeployError("This deployer only installs james-design-team")
    return name, match.group(2).strip()


def prepare_bundle(package_dir):
    root = Path(package_dir).resolve()
    if not root.is_dir():
        raise DeployError("Native package directory does not exist")
    entries = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        if path.is_symlink():
            raise DeployError("Package symlinks are not accepted")
        if path.is_file() and path.suffix not in (".pyc", ".pyo"):
            entries[relative.as_posix()] = path.read_bytes()
    if "SKILL.md" not in entries:
        raise DeployError("Package has no SKILL.md")
    name, body = parse_skill_markdown(entries["SKILL.md"].decode("utf-8"))
    try:
        version = json.loads(entries.get(RELEASE_PATH, b"{}"))["version"]
    except (ValueError, KeyError):
        raise DeployError("references/release.json needs an explicit version") from None
    if not isinstance(version, str) or not version.strip():
        raise DeployError("Release version must be a nonempty string")
    hashes = {path: sha256(data) for path, data in sorted(entries.items())
              if path not in ("SKILL.md", RELEASE_PATH)}
    release = {
        "version": version, "digest": object_hash(hashes), "files": hashes,
        "skillMarkdownSha256": sha256(entries["SKILL.md"]), "bodySha256": sha256(body.encode()),
    }
    entries[RELEASE_PATH] = (json.dumps(release, indent=2, sort_keys=True) + "\n").encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, data in sorted(entries.items()):
            info = zipfile.ZipInfo(path, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    return {"name": name, "body": body, "release": release, "entries": entries,
            "zipBase64": base64.b64encode(buffer.getvalue()).decode()}


def private_directory(path):
    location = Path(path).expanduser().resolve()
    if any((parent / ".git").exists() for parent in (location, *location.parents)):
        raise DeployError("Private snapshots must be outside every Git checkout")
    return location


class Snapshots:
    def __init__(self, directory, apply):
        self.location = private_directory(directory)
        self.enabled = apply
        self.sequence = 0
        if apply:
            self.location.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.location, 0o700)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            self.location = self.location / (stamp + "-" + secrets.token_hex(4))
            self.location.mkdir(mode=0o700)

    def save(self, label, value):
        if not self.enabled:
            return
        self.sequence += 1
        name = re.sub(r"[^A-Za-z0-9_.-]", "-", label)
        path = self.location / f"{self.sequence:03d}-{name}.json"
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")


def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise DeployError("Explicit target IDs must be simple native identifiers")
    return value


def _one(rows, key, value, label):
    matches = [row for row in rows if row.get(key) == value]
    if len(matches) != 1:
        raise DeployError(f"Expected exactly one {label}")
    return matches[0]


def validate_targets(config, roles, adapters, catalog, groups, skills):
    targets = config.get("agents", [])
    if len(targets) != 10 or len({target.get("id") for target in targets}) != 10:
        raise DeployError("Config must explicitly name ten distinct designers")
    if len({target.get("role") for target in targets}) != 10:
        raise DeployError("Every designer must have one distinct role")
    group = _one(groups, "id", _id(config.get("group", {}).get("id")), "configured design group")
    if group.get("name") != config["group"].get("name"):
        raise DeployError("Design group name differs from the private config")
    if set(group.get("agentIds", [])) != {target["id"] for target in targets}:
        raise DeployError("Design group membership differs from the ten explicit targets")
    role_map = {role["id"]: role for role in roles}
    if len(role_map) != len(roles) or set(role_map) != {target["role"] for target in targets}:
        raise DeployError("Role registry and explicit target roles must match")
    for target in targets:
        row = _one(catalog, "id", _id(target["id"]), "configured designer")
        for field in ("name", "handle"):
            if not target.get(field) or row.get(field) != target[field]:
                raise DeployError(f"Configured designer {field} no longer matches")
        role = role_map[target["role"]]
        if role.get("handle") != target["handle"]:
            raise DeployError("Role handle differs from the configured live handle")
    legacy = config.get("legacySkills", [])
    if len({item.get("name") for item in legacy}) != len(legacy):
        raise DeployError("Duplicate legacy skill names in private config")
    if set(adapters) != {item.get("name") for item in legacy}:
        raise DeployError("Every legacy adapter needs an exact explicit name and ID")
    if SKILL_NAME in adapters:
        raise DeployError("The canonical package cannot be a legacy body adapter")
    for target in legacy:
        row = _one(skills, "id", _id(target["id"]), "configured legacy skill")
        if row.get("name") != target.get("name"):
            raise DeployError("Legacy skill name differs from the explicit target")
    return role_map


def read_agent(api, target):
    base = "/agents/" + _id(target["id"])
    detail = api.request("GET", base)
    for key in ("id", "name", "handle"):
        if detail.get(key) != target.get(key):
            raise DeployError("Designer identity changed; refused to update")
    return {"detail": detail, "access": api.request("GET", base + "/access"),
            "brain": api.request("GET", base + "/brain"),
            "skills": api.request("GET", base + "/skills")["skills"]}


def agent_guard(state):
    brain = state["brain"]
    return {"detail": selected(state["detail"], DETAIL_FIELDS), "access": state["access"],
            "brain": selected(brain, ("configHash", "brain", "model", "effectiveModel", "autonomy", "effort", "speed"))}


def assignment_guard(before, after, ignored_id=None):
    previous = {row["id"]: row["enabled"] for row in before if row["id"] != ignored_id}
    fresh = {row["id"]: row["enabled"] for row in after if row["id"] != ignored_id}
    if any(key not in fresh or fresh[key] != enabled for key, enabled in previous.items()):
        raise DeployError("An existing skill assignment changed; refusing a stale update")


def assert_agent_preserved(before, after, skill_id=None):
    if object_hash(agent_guard(before)) != object_hash(agent_guard(after)):
        raise DeployError("Designer model, identity, brain, access or protected settings changed")
    assignment_guard(before["skills"], after["skills"], skill_id)


def skill_state(skill):
    return selected(skill, SKILL_FIELDS)


def read_text_resource(api, skill, path):
    escaped = urllib.parse.quote(path, safe="")
    return api.request("GET", f"/skills/{_id(skill['id'])}/files/{escaped}?version={skill['version']}")["content"]


def installed_matches(api, skill, bundle):
    if skill is None or skill.get("name") != bundle["name"] or skill.get("body") != bundle["body"]:
        return False
    try:
        release = json.loads(read_text_resource(api, skill, RELEASE_PATH))
    except APIError as error:
        if error.status == 404:
            return False
        raise
    except (ValueError, KeyError):
        return False
    if release != bundle["release"]:
        return False
    expected = {path: data for path, data in bundle["entries"].items() if path != "SKILL.md"}
    files = {row["path"]: row for row in skill.get("files", [])}
    if set(files) != set(expected):
        return False
    for path, data in expected.items():
        row = files[path]
        if row.get("status") not in ("stored", "script") or row.get("size") != len(data):
            return False
        mime = row.get("mime", "")
        if row.get("status") == "stored" and (mime.startswith("text/") or mime == "application/json"):
            if read_text_resource(api, skill, path).encode() != data:
                return False
    return True


def _find_native(catalog):
    found = [row for row in catalog if row.get("name") == SKILL_NAME]
    if len(found) > 1:
        raise DeployError("Duplicate canonical skill names")
    return found[0] if found else None


def deploy(config, package_dir, adapters, api, apply=False):
    bundle = prepare_bundle(package_dir)
    try:
        roles = json.loads(bundle["entries"]["references/roles.json"])["roles"]
    except (ValueError, KeyError):
        raise DeployError("Package roles.json must contain a roles array") from None
    snapshots = Snapshots(config["snapshotDir"], apply)
    catalog = api.request("GET", "/agents")["agents"]
    groups = api.request("GET", "/agent-groups")["groups"]
    skills = api.request("GET", "/skills")["skills"]
    role_map = validate_targets(config, roles, adapters, catalog, groups, skills)
    native = _find_native(skills)
    existing = api.request("GET", "/skills/" + _id(native["id"])) if native else None
    states = {target["id"]: read_agent(api, target) for target in config["agents"]}
    legacy = {target["name"]: api.request("GET", "/skills/" + _id(target["id"]))
              for target in config.get("legacySkills", [])}
    # Validate every text transformation before the first production write.
    for target in config["agents"]:
        text = states[target["id"]]["detail"]["instructions"]
        reconcile_instructions(text, text, role_block(role_map[target["role"]]))
    for name, row in legacy.items():
        apply_adapter(row["body"], adapters[name])
    snapshots.save("baseline", {"agents": states, "nativeSkill": existing, "legacySkills": legacy,
                                "group": config["group"], "release": bundle["release"]})
    same = installed_matches(api, existing, bundle)
    receipt = {"mode": "apply" if apply else "dry-run", "agents": len(states),
               "digest": bundle["release"]["digest"], "release": bundle["release"]["version"],
               "package": "unchanged" if same else "update" if existing else "create",
               "instructionChanges": 0, "assignmentChanges": 0, "legacyChanges": 0,
               "nativeSkill": None, "snapshots": str(snapshots.location) if apply else None,
               "serverCAS": False}
    if apply and not same:
        fresh_catalog = api.request("GET", "/skills")["skills"]
        fresh_row = _find_native(fresh_catalog)
        if bool(fresh_row) != bool(existing):
            raise DeployError("Canonical skill appeared or disappeared concurrently")
        if existing:
            fresh = api.request("GET", "/skills/" + _id(fresh_row["id"]))
            if object_hash(skill_state(fresh)) != object_hash(skill_state(existing)):
                raise DeployError("Canonical skill version/content changed concurrently")
        snapshots.save("before-native-import", existing)
        imported = api.request("POST", "/skills/import",
                               {"zipBase64": bundle["zipBase64"], "createOnly": existing is None})
        if existing and imported.get("id") != existing["id"]:
            raise DeployError("Import unexpectedly changed the native skill identity")
        existing = api.request("GET", "/skills/" + _id(imported["id"]))
        if not installed_matches(api, existing, bundle):
            raise DeployError("Native package readback did not match the imported release")
        snapshots.save("after-native-import", existing)
    skill_id = existing["id"] if existing else None
    if existing:
        receipt["nativeSkill"] = {"id": existing["id"], "version": existing["version"]}
    for name, original in legacy.items():
        desired = apply_adapter(original["body"], adapters[name])
        if desired == original["body"]:
            continue
        receipt["legacyChanges"] += 1
        if not apply:
            continue
        route = "/skills/" + _id(original["id"])
        fresh = api.request("GET", route)
        if object_hash(skill_state(fresh)) != object_hash(skill_state(original)):
            raise DeployError("Legacy skill version/content changed concurrently")
        snapshots.save("before-legacy-" + name, fresh)
        api.request("PATCH", route, {"body": desired})
        after = api.request("GET", route)
        if after.get("body") != desired:
            raise DeployError("Legacy body readback did not match")
        protected = tuple(key for key in SKILL_FIELDS if key not in ("body", "version"))
        if selected(fresh, protected) != selected(after, protected):
            raise DeployError("Legacy body update changed unrelated skill settings/resources")
        snapshots.save("after-legacy-" + name, after)
    for target in config["agents"]:
        original = states[target["id"]]
        block = role_block(role_map[target["role"]])
        fresh = read_agent(api, target) if apply else original
        assert_agent_preserved(original, fresh, skill_id)
        desired = reconcile_instructions(original["detail"]["instructions"],
                                         fresh["detail"]["instructions"], block)
        route = "/agents/" + _id(target["id"])
        if desired != fresh["detail"]["instructions"]:
            receipt["instructionChanges"] += 1
            if apply:
                snapshots.save("before-instructions-" + target["role"], fresh)
                api.request("PATCH", route, {"instructions": desired})
                after = read_agent(api, target)
                if after["detail"]["instructions"] != desired:
                    raise DeployError("Managed instructions readback did not match")
                assert_agent_preserved(fresh, after, skill_id)
                snapshots.save("after-instructions-" + target["role"], after)
                fresh = after
        enabled = any(row["id"] == skill_id and row["enabled"] for row in fresh["skills"])
        if not enabled:
            receipt["assignmentChanges"] += 1
            if apply:
                if not skill_id:
                    raise DeployError("No native skill ID after import")
                checked = read_agent(api, target)
                assert_agent_preserved(fresh, checked, skill_id)
                # Never submit the old full assignment list.
                snapshots.save("before-assignment-" + target["role"], checked)
                api.request("PUT", route + "/skills", {"skills": [{"skillId": skill_id, "enabled": True}]})
                after = read_agent(api, target)
                assert_agent_preserved(checked, after, skill_id)
                if not any(row["id"] == skill_id and row["enabled"] for row in after["skills"]):
                    raise DeployError("Native skill assignment readback failed")
                snapshots.save("after-assignment-" + target["role"], after)
    if apply:
        for target in config["agents"]:
            final = read_agent(api, target)
            assert_agent_preserved(states[target["id"]], final, skill_id)
            expected = _section(merge_managed_block("", role_block(role_map[target["role"]])))
            if _section(final["detail"]["instructions"]) != expected:
                raise DeployError("Final managed section verification failed")
            if not any(row["id"] == skill_id and row["enabled"] for row in final["skills"]):
                raise DeployError("Final native assignment verification failed")
        receipt["preservedModelsAccessAndExistingAssignments"] = True
        snapshots.save("receipt", receipt)
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="Private local JSON config, outside Git")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", action="store_true", help="Apply the reviewed native updates")
    modes.add_argument("--dry-run", action="store_true", help="Read and compare only (default)")
    parser.add_argument("--package", type=Path, default=REPO / "examples/skills/james-design-team")
    parser.add_argument("--adapters", type=Path, default=Path(__file__).with_name("legacy-adapters.json"))
    args = parser.parse_args(argv)
    try:
        private_directory(args.config.resolve().parent)
        config = json.loads(args.config.read_text())
        adapters = json.loads(args.adapters.read_text())
        api = NativeAPI(config, allow_writes=args.apply)
        receipt = deploy(config, args.package, adapters, api, apply=args.apply)
        print(json.dumps(receipt, sort_keys=True))
        return 0
    except (DeployError, KeyError, ValueError, TypeError, OSError) as error:
        # Never render request/session objects, HTTP bodies, or tracebacks.
        message = str(error) if isinstance(error, DeployError) else "Invalid local configuration or package files"
        print(json.dumps({"status": "error", "error": message, "retry": "Inspect private snapshots and current state before retrying."}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
