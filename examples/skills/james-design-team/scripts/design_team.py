#!/usr/bin/env python3
"""Native skill CLI. Offline; no credentials, external publishing or telemetry."""
import argparse
import json
from pathlib import Path
import sys

from team_core import package_hashes, plan_task

ROOT = Path(__file__).resolve().parents[1]

def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def parser():
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)
    for name in ("plan", "validate"):
        command = sub.add_parser(name)
        source = command.add_mutually_exclusive_group(required=True)
        source.add_argument("--input")
        source.add_argument("--request-json")
        if name == "validate":
            command.add_argument("--workspace", required=True)
    sub.add_parser("catalog")
    sub.add_parser("self-check")
    return result

def main(argv=None):
    args = parser().parse_args(argv)
    try:
        catalog = read_json(ROOT / "references/capabilities.json")
        roles = read_json(ROOT / "references/roles.json")
        if args.command == "catalog":
            output = {"capabilities": catalog, "roles": roles}
            code = 0
        elif args.command == "self-check":
            hashes, digest = package_hashes(ROOT)
            release_path = ROOT / "references/release.json"
            release = read_json(release_path) if release_path.exists() else None
            verified = bool(release and release.get("digest") == digest and release.get("files") == hashes)
            output = {"verified": verified, "digest": digest, "fileHashes": hashes,
                      "releaseVersion": release.get("version") if release else None,
                      "scope": "Local package byte integrity; not proof of external connector availability."}
            code = 0 if verified else 1
        else:
            data = read_json(args.input) if args.input else json.loads(args.request_json)
            if args.command == "plan":
                output = plan_task(data, catalog, roles)
                code = 0
            else:
                from team_core import validate_delivery
                if not isinstance(data, dict) or "plan" not in data or "manifest" not in data:
                    raise ValueError("validate requires an object containing plan and manifest")
                output = validate_delivery(data["plan"], data["manifest"], Path(args.workspace))
                code = 0 if output["verified"] else 1
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return code
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error), "verified": False}, ensure_ascii=False))
        return 2

if __name__ == "__main__":
    sys.exit(main())
