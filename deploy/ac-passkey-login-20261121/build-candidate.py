#!/usr/bin/env python3
"""Build the scoped Passkey candidate without touching the running app or database."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request

BASE = "sha256:a620ca539fae6b5734b78df6820146280471d7ccb52d9ce42f7583b1eff8d8af"
BASE_REV = "4963195313ce5d4797b4531bbaef578a3fe2003c"
BASE_SOURCE = {"digest": "sha256:afe0981743a945fdd80afc6db3f76919b6268ae8c391107b461a68549b57cd29", "files": 3308}
RUNNER_SHA = "cea9a0f82e544e0c6bcc84746c6de2ae09e0eae17b916227b9d43b9a392dd8f4"
SOURCE_URL = "https://github.com/dev-james0723/agentes-chat"
BUN_VERSION = "1.4.4"
AUTH_VERSION = "1.7.27"
JOURNAL = "packages/db/migrations/meta/_journal.json"
MANIFEST_IN_IMAGE = "/tmp/ac-passkey-assets.json"
REPO = Path(__file__).resolve().parents[2]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def output(argv, cwd=None, timeout=60):
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "Command failed; inspect the private release evidence")
    return result.stdout.strip()


def private_json(path, data, exclusive=False):
    path = Path(path)
    require(not path.is_symlink(), "Receipt must not be a symlink")
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write((json.dumps(data, indent=2) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def evidence_directory(path, repo):
    path = Path(path).expanduser().resolve()
    require(not path.is_relative_to(Path(repo).resolve()), "Private evidence must be outside the Git worktree")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.is_dir() and not (path.stat().st_mode & 0o077), "Evidence directory must have mode 0700")
    return path


def local_origin(value):
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
            and parsed.path in ("", "/"), "Health origin must be an explicit loopback HTTP origin")
    try:
        require(parsed.port is not None, "Health origin must include the app port")
    except ValueError as error:
        raise RuntimeError("Invalid health origin port") from error
    return value.rstrip("/")


def read_health(origin):
    request = urllib.request.Request(local_origin(origin) + "/api/health", headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=5) as response:
        require(response.status == 200 and response.geturl() == request.full_url, "Unexpected health response")
        data = json.load(response)
    return data


def inspect_live(docker, container, origin, expected_image=BASE, expected_source=BASE_SOURCE):
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", container), "Invalid container name")
    fields = '{{json .Image}}\n{{json .State.Running}}'
    image_id, running = map(json.loads, output(docker + ["inspect", "--format", fields, container]).splitlines())
    require(image_id == expected_image and running is True,
            "Live image changed or is not running; reconcile before release")
    health = read_health(origin)
    require(health.get("status") == "ok" and health.get("database") == "ok"
            and health.get("source") == expected_source, "Live source/database health differs from the reviewed baseline")
    return health


def runtime_path(path):
    parts = path.split("/")
    if len(parts) == 1:
        return path in ("package.json", "bun.lock", "bunfig.toml")
    if parts[0] not in ("apps", "packages") or any(x in ("node_modules", "dist", ".turbo", "coverage") for x in parts):
        return False
    return (len(parts) == 3 and parts[2] == "package.json") or (len(parts) >= 4 and
            (parts[2] == "src" or parts[:3] == ["apps", "server", "runner"] or
             parts[:3] == ["packages", "db", "migrations"]))


def safe_source(repo, name):
    relative = Path(name)
    require(not relative.is_absolute() and ".." not in relative.parts and relative.parts,
            "Invalid source path")
    source = Path(repo) / relative
    require(source.is_file() and not source.is_symlink() and source.resolve().is_relative_to(Path(repo).resolve()),
            "Runtime source must be a contained regular file")
    require(not any(part.startswith(".env") or part in (".npmrc", ".netrc") for part in relative.parts),
            "Credential/configuration file is not a source payload")
    return source


def read_changes(repo, revision):
    raw = subprocess.check_output(["git", "diff", "--no-renames", "--name-status", "-z", BASE_REV, revision], cwd=repo)
    fields = raw.decode().split("\0")
    if fields[-1] == "":
        fields.pop()
    require(len(fields) % 2 == 0, "Unexpected Git name-status format")
    return list(zip(fields[::2], fields[1::2]))


def check_migration(before, after, changes, repo):
    old, new = before.get("entries"), after.get("entries")
    require(isinstance(old, list) and isinstance(new, list) and len(new) == len(old) + 1
            and new[:-1] == old, "Exactly one append-only migration is required")
    require({k: v for k, v in before.items() if k != "entries"} ==
            {k: v for k, v in after.items() if k != "entries"}, "Migration journal format changed")
    entry = new[-1]
    require(entry.get("idx") == old[-1]["idx"] + 1 and entry.get("when", 0) > max(x["when"] for x in old),
            "New migration index/time must follow the current journal")
    tag = entry.get("tag", "")
    require(re.fullmatch(r"0283_[a-z0-9_]+", tag) is not None, "Passkey migration must append after 0282")
    sql = "packages/db/migrations/" + tag + ".sql"
    snapshot = "packages/db/migrations/meta/0283_snapshot.json"
    allowed = {JOURNAL: "M", sql: "A", snapshot: "A"}
    actual = {path: status for status, path in changes if path.startswith("packages/db/migrations/")}
    require(actual == allowed, "Existing migrations must not change; expected one SQL, snapshot and journal append")
    return {"tag": tag, "when": entry["when"], "sqlPath": sql,
            "sqlSha256": file_sha(safe_source(repo, sql)), "table": "passkeys"}


def verify_image(docker, image_id, revision, source):
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), "Candidate image is not immutable")
    candidate, base = json.loads(output(docker + ["image", "inspect", image_id, BASE]))
    layers = base["RootFS"]["Layers"]
    require(candidate["Id"] == image_id and base["Id"] == BASE and layers
            and candidate["RootFS"]["Type"] == base["RootFS"]["Type"] == "layers"
            and len(candidate["RootFS"]["Layers"]) > len(layers)
            and candidate["RootFS"]["Layers"][:len(layers)] == layers,
            "Candidate must extend the pinned current image")
    require(candidate["Config"].get("User") == base["Config"].get("User") == "bun",
            "Candidate must preserve the original unprivileged runtime user")
    labels = candidate["Config"].get("Labels") or {}
    require(labels.get("org.opencontainers.image.revision") == revision
            and labels.get("org.opencontainers.image.source") == SOURCE_URL
            and labels.get("chat.agentes.source-digest") == source["digest"], "Candidate provenance mismatch")


def image_preservation(docker, image_id):
    js = """
import {readFileSync,readdirSync} from 'node:fs'; import {createHash} from 'node:crypto';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const entries=[]; const root='/app/apps/web/dist';
function scan(dir){for(const e of readdirSync(root+'/'+dir,{withFileTypes:true})){const p=dir?dir+'/'+e.name:e.name;
 if(e.isSymbolicLink())throw new Error('unexpected asset symlink');
 if(e.isDirectory())scan(p);else if(e.isFile())entries.push([p,hash(root+'/'+p)]);}}
scan(''); entries.sort((a,b)=>a[0].localeCompare(b[0],'en'));
console.log(JSON.stringify({assetDigest:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
 assetCount:entries.length,runnerSha256:hash(root+'/runner/agentes-runner.mjs'),lockSha256:hash('/app/bun.lock')}));
"""
    return json.loads(output(docker + ["run", "--rm", "--network=none", "--read-only", "--entrypoint", "bun", image_id, "-e", js]))


def build_fallback(docker, bun, repo, revision, migration, evidence, base_tag):
    """The previous application with the new additive history, so its normal boot guard still works."""
    paths = [migration["sqlPath"], JOURNAL, "packages/db/migrations/meta/0283_snapshot.json"]
    js = ('import {gitSourceEntries,sourceIdentityOf} from "./apps/server/src/source-identity.ts";'
          + 'const base=new Map(gitSourceEntries(process.cwd(),' + json.dumps(BASE_REV) + ').map(e=>[e.path,e]));'
          + 'const selected=new Set(' + json.dumps(paths) + ');'
          + 'for(const e of gitSourceEntries(process.cwd(),' + json.dumps(revision) + ')){if(selected.has(e.path))base.set(e.path,e);}'
          + 'console.log(JSON.stringify(sourceIdentityOf([...base.values()])));')
    expected = json.loads(output([str(bun), "-e", js], cwd=repo))
    context = evidence / ("fallback-" + revision[:12])
    require(not context.exists(), "Fallback context already exists; inspect prior effects before retrying")
    context.mkdir(mode=0o700)
    for name in paths:
        destination = context / "overlay" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(safe_source(repo, name), destination)
    tag = "agentes-chat-local:passkey-fallback-" + revision[:12]
    # No install/RUN step: old application, dependencies and all assets remain in the original layers.
    (context / "Dockerfile").write_text(
        f'FROM {base_tag}\nCOPY ["overlay/", "/app/"]\n'
        f'LABEL org.opencontainers.image.revision="" org.opencontainers.image.source="{SOURCE_URL}" '
        f'chat.agentes.source-digest="{expected["digest"]}" chat.agentes.base-revision="{BASE_REV}" '
        f'chat.agentes.migration-revision="{revision}" chat.agentes.source-kind="base-plus-passkey-migration"\n')
    run_logged(docker + ["build", "--pull=false", "--network=none", "-t", tag, str(context)], context / "image-build.log")
    image_id = output(docker + ["image", "inspect", tag, "--format", "{{.Id}}"])
    verify_image(docker, image_id, "", expected)
    actual_js = 'import {runningSourceIdentity} from "./apps/server/src/source-identity.ts"; console.log(JSON.stringify(await runningSourceIdentity()()));'
    actual = json.loads(output(docker + ["run", "--rm", "--network=none", "--read-only", "-w", "/app", "--entrypoint", "bun", image_id, "-e", actual_js]))
    require(actual == expected, "Fallback source is not precisely base plus reviewed migration metadata")
    previous, fallback = image_preservation(docker, BASE), image_preservation(docker, image_id)
    require(previous == fallback and fallback["runnerSha256"] == RUNNER_SHA,
            "Fallback changed original assets, dependency lock or runner")
    return {"imageId": image_id, "tag": tag, "source": expected, "baseCodeRevision": BASE_REV,
            "migrationRevision": revision, "sourceKind": "base-plus-passkey-migration", "sourceVerified": True,
            "copiedPaths": paths, "preserved": fallback, "context": str(context)}


def run_logged(argv, path, cwd=None, env=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as log:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    require(result.returncode == 0, "Build failed; inspect the private build log")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    parser.add_argument("--bun", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--docker", required=True, type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--http-origin", required=True)
    args = parser.parse_args()
    docker = [str(args.docker), "--context", args.docker_context]
    repo = REPO
    require(re.fullmatch(r"[0-9a-f]{40}", args.revision), "Use the full reviewed revision")
    require(output(["git", "rev-parse", "HEAD"], cwd=repo) == args.revision, "Reviewed HEAD moved")
    require(not output(["git", "status", "--porcelain"], cwd=repo), "Commit and reconcile all source changes first")
    output(["git", "merge-base", "--is-ancestor", BASE_REV, args.revision], cwd=repo)
    require(output([str(args.bun), "--version"]) == BUN_VERSION, "Wrong host Bun version")
    for directory in (repo, repo / "apps/web"):
        require(not any(path.is_file() for path in directory.glob(".env*") if path.name != ".env.example"),
                "Do not build the candidate with local environment/credential files")
    inspect_live(docker, args.container, args.http_origin)
    identity = json.loads(output([str(args.bun), "scripts/runtime-identity.ts", "rev", args.revision], cwd=repo))
    source = {key: identity[key] for key in ("digest", "files")}
    changes = read_changes(repo, args.revision)
    old_journal = json.loads(subprocess.check_output(["git", "show", BASE_REV + ":" + JOURNAL], cwd=repo))
    new_journal = json.loads((repo / JOURNAL).read_text())
    migration = check_migration(old_journal, new_journal, changes, repo)
    paths = set()
    for status, name in changes:
        if runtime_path(name):
            require(status in ("M", "A"), "Runtime deletions or renames need a separately reviewed recipe")
            paths.add(name)
    # Copy the reviewed manifests for every workspace, never a host node_modules directory or npm credentials.
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=repo).decode().split("\0")
    paths.update(name for name in tracked if re.fullmatch(r"(?:apps|packages)/[^/]+/package.json", name))
    paths.update(("package.json", "bun.lock", "bunfig.toml"))
    require("apps/server/src/auth.ts" in paths and "apps/web/src/auth/better-auth.ts" in paths,
            "The Passkey integration is absent from the reviewed change")
    evidence = evidence_directory(args.evidence_dir, repo)
    context = evidence / ("candidate-" + args.revision[:12])
    require(not context.exists(), "Candidate context already exists; inspect previous effects before retrying")
    context.mkdir(mode=0o700)
    private_json(context / "state.json", {"state": "building", "revision": args.revision, "startedAt": now()}, True)
    web_environment = {key: value for key, value in os.environ.items()
                       if key in ("PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL")}
    web_environment.update(CI="1", NODE_ENV="production")
    run_logged([str(args.node), "node_modules/vite/bin/vite.js", "build"], context / "web-build.log", repo / "apps/web", web_environment)
    require(output(["git", "rev-parse", "HEAD"], cwd=repo) == args.revision
            and not output(["git", "status", "--porcelain"], cwd=repo), "Source changed while building")
    overlay = context / "overlay"
    for name in sorted(paths):
        source_file = safe_source(repo, name)
        destination = overlay / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_file, destination)
    dist = repo / "apps/web/dist"
    require((dist / "index.html").is_file(), "Web build did not produce an index")
    for item in dist.rglob("*"):
        require(not item.is_symlink(), "Unexpected web build symlink")
    built_dist = overlay / "apps/web/dist"
    shutil.copytree(dist, built_dist)
    runner = built_dist / "runner/agentes-runner.mjs"
    if not runner.exists():
        runner.parent.mkdir(parents=True, exist_ok=True)
        with runner.open("wb") as stream:
            subprocess.run(docker + ["run", "--rm", "--network=none", "--read-only", "--entrypoint", "cat", BASE,
                                    "/app/apps/web/dist/runner/agentes-runner.mjs"], stdout=stream,
                           stderr=subprocess.DEVNULL, check=True)
    require(file_sha(runner) == RUNNER_SHA, "Distributed runner changed")
    assets = {item.relative_to(built_dist).as_posix(): file_sha(item) for item in sorted(built_dist.rglob("*")) if item.is_file()}
    manifest = (json.dumps(assets, sort_keys=True) + "\n").encode()
    (context / "assets.json").write_bytes(manifest)
    base_tag = "ac-passkey-build-base:" + BASE.split(":")[1][:12]
    tag = "agentes-chat-local:passkey-" + args.revision[:12]
    # Apply the frozen lockfile inside a disposable Linux layer, reusing unchanged Linux
    # dependencies from the pinned parent. Recopying the entire monorepo exhausts small
    # Docker disks; no host dependency tree, live mount or credentials enter this build.
    install = ("test \"$(bun --version)\" = \"" + BUN_VERSION + "\" && "
               "test ! -e /app/.env && test ! -e /app/.npmrc && test ! -e /root/.npmrc && "
               "env NODE_ENV=development bun install --frozen-lockfile")
    dockerfile = (f"FROM {base_tag}\nUSER root\nWORKDIR /app\nCOPY [\"overlay/\", \"/app/\"]\n"
                  + "RUN " + json.dumps(["/bin/sh", "-c", install]) + "\n"
                  + f"COPY [\"assets.json\", \"{MANIFEST_IN_IMAGE}\"]\n"
                  + "USER bun\n"
                  + f"LABEL org.opencontainers.image.revision=\"{args.revision}\" "
                    f"org.opencontainers.image.source=\"{SOURCE_URL}\" chat.agentes.source-digest=\"{source['digest']}\"\n")
    (context / "Dockerfile").write_text(dockerfile)
    output(docker + ["tag", BASE, base_tag])
    require(output(docker + ["image", "inspect", base_tag, "--format", "{{.Id}}"] ) == BASE, "Base tag changed")
    run_logged(docker + ["build", "--pull=false", "--network=default", "-t", tag, str(context)], context / "image-build.log")
    image_id = output(docker + ["image", "inspect", tag, "--format", "{{.Id}}"])
    verify_image(docker, image_id, args.revision, source)
    js = 'import {runningSourceIdentity} from "./apps/server/src/source-identity.ts"; console.log(JSON.stringify(await runningSourceIdentity()()));'
    actual = json.loads(output(docker + ["run", "--rm", "--network=none", "--read-only", "-w", "/app", "--entrypoint", "bun", image_id, "-e", js]))
    require(actual == source, "Candidate runtime source differs from reviewed Git source")
    verify_js = """
import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const m = JSON.parse(readFileSync('/tmp/ac-passkey-assets.json', 'utf8'));
const packages = ['apps/server/node_modules/better-auth', 'apps/server/node_modules/@better-auth/passkey',
 'apps/server/node_modules/@better-auth/expo', 'apps/web/node_modules/better-auth', 'apps/web/node_modules/@better-auth/passkey'];
const versions = Object.fromEntries(packages.map(p => [p, JSON.parse(readFileSync('/app/'+p+'/package.json','utf8')).version]));
console.log(JSON.stringify({platform:process.platform, bun:Bun.version, versions, count:Object.keys(m).length,
 mismatches:Object.entries(m).filter(([p,h])=>hash('/app/apps/web/dist/'+p)!==h).map(([p])=>p),
 manifestSha256:hash('/tmp/ac-passkey-assets.json'), runnerSha256:hash('/app/apps/web/dist/runner/agentes-runner.mjs')}));
"""
    verified = json.loads(output(docker + ["run", "--rm", "--network=none", "--read-only", "--entrypoint", "bun", image_id, "-e", verify_js]))
    require(verified["platform"] == "linux" and verified["bun"] == BUN_VERSION
            and all(version == AUTH_VERSION for version in verified["versions"].values())
            and not verified["mismatches"] and verified["count"] == len(assets)
            and verified["manifestSha256"] == sha(manifest) and verified["runnerSha256"] == RUNNER_SHA,
            "Candidate dependency or asset verification failed")
    output(docker + ["run", "--rm", "--network=none", "--read-only", "-w", "/app/apps/server", "--entrypoint", "bun", image_id,
                    "-e", 'await import("@better-auth/passkey"); console.log("passkey-import-ok")'])
    fallback = build_fallback(docker, args.bun, repo, args.revision, migration, evidence, base_tag)
    inspect_live(docker, args.container, args.http_origin)
    receipt = {"schema": "ac-passkey-candidate-v1", "builtAt": now(), "revision": args.revision,
               "baseRevision": BASE_REV, "baseImageId": BASE, "baseSource": BASE_SOURCE,
               "imageId": image_id, "tag": tag, "source": source, "sourceVerified": True,
               "copiedPaths": sorted(paths), "migration": migration, "assets": verified,
               "fallback": fallback,
               "context": str(context), "manifestPath": str(context / "assets.json"),
               "runningInstallationChanged": False}
    receipt_path = evidence / ("image-receipt-" + args.revision[:12] + ".json")
    private_json(receipt_path, receipt, True)
    private_json(context / "state.json", {"state": "built-not-activated", "revision": args.revision, "receipt": str(receipt_path)})
    print(json.dumps({"receipt": str(receipt_path), "imageId": image_id, "source": source,
                      "fallbackImageId": fallback["imageId"], "activated": False}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit("Passkey candidate build refused: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
