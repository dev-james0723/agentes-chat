#!/usr/bin/env python3
"""Export an owner's accepted native shared memory. Python 3.10+, standard library only.

The native profile stays authoritative. This writes local files, never imports into
Claude or ChatGPT, and does not infer permission from memory text. See
docs/shared-memory-export.md for the operator contract and failure behavior.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings


MAX_RESPONSE = 16 * 1024 * 1024
MAX_TRANSFER = 64 * 1024 * 1024
MAX_PAGES = 50
PAGE_SIZE = 200
REQUEST_TIMEOUT = 15
RUN_TIMEOUT = 120
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class ExportError(Exception):
    """An operator-safe message containing neither credentials nor server content."""


def origin(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or any(ord(char) <= 32 or ord(char) >= 127 for char in value)
            or "\\" in value
        ):
            raise ValueError()
        host = parsed.hostname.lower()
        port = parsed.port
        if parsed.scheme == "http":
            if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
                raise ValueError()
        host = f"[{host}]" if ":" in host else host
        return f"{parsed.scheme}://{host}" + (f":{port}" if port is not None else "")
    except (ValueError, TypeError):
        raise ExportError("Use an HTTPS origin or a loopback HTTP origin, without a path or credentials") from None


def private_file(fd: int, *, exact_mode: bool = False) -> None:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ExportError("A private regular file owned by this user is required")
    if exact_mode and stat.S_IMODE(info.st_mode) != 0o600:
        raise ExportError("An exported file no longer has mode 0600")


def read_cookie(path: Path) -> str:
    try:
        fd = os.open(path, os.O_RDONLY | NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            private_file(stream.fileno())
            raw = stream.read(16_385)
        if len(raw) > 16_384:
            raise ExportError("The cookie file exceeds the supported size")
        value = raw.decode("ascii").rstrip("\r\n")
        if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError()
        if any(not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]*", part.strip()) for part in value.split(";")):
            raise ValueError()
        return value
    except ExportError:
        raise
    except (OSError, UnicodeError, ValueError):
        raise ExportError("Cannot read a private cookie file containing one Cookie header value") from None


def read_cookie_jar(path: Path) -> http.cookiejar.MozillaCookieJar:
    """Read the existing jar in place. Never export, rewrite, or save its credentials."""
    try:
        fd = os.open(path, os.O_RDONLY | NOFOLLOW)
        try:
            private_file(fd)
            before = os.fstat(fd)
            if before.st_size > 1024 * 1024:
                raise ExportError("The cookie jar exceeds the supported size")
            jar = http.cookiejar.MozillaCookieJar(policy=http.cookiejar.DefaultCookiePolicy(
                strict_ns_domain=http.cookiejar.DefaultCookiePolicy.DomainStrict))
            # Malformed Netscape rows can otherwise appear in a stdlib parser warning.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                jar.load(str(path), ignore_discard=True, ignore_expires=False)
            after = os.stat(path, follow_symlinks=False)
            signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            if signature(before) != signature(after):
                raise ExportError("The cookie jar changed while it was read")
            return jar
        finally:
            os.close(fd)
    except ExportError:
        raise
    except (OSError, ValueError):
        raise ExportError("Cannot read the private Netscape cookie jar") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ExportError("The server redirected the request; no credentials were forwarded")


class Api:
    def __init__(self, base_url: str, org_id: str, cookie: str | None = None, *, cookie_jar: http.cookiejar.CookieJar | None = None):
        self.base = origin(base_url)
        try:
            self.org_id = str(uuid.UUID(org_id))
        except ValueError:
            raise ExportError("org-id must be a workspace UUID") from None
        self.path = f"/api/app/organizations/{self.org_id}/shared-memory"
        self.cookie = cookie
        # A configured environment proxy must never receive a local session cookie.
        handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
        if cookie_jar is not None:
            handlers.append(urllib.request.HTTPCookieProcessor(cookie_jar))
        self.opener = urllib.request.build_opener(*handlers)
        self.deadline = time.monotonic() + RUN_TIMEOUT
        self.received = 0

    def request(self, suffix: str = "", *, query: dict | None = None, body: dict | None = None) -> dict:
        if suffix not in ("", "/actions"):
            raise ExportError("Unsupported API path")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ExportError("The export time limit was reached")
        url = self.base + self.path + suffix
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Accept": "application/json", "Origin": self.base}
        if self.cookie is not None:
            headers["Cookie"] = self.cookie
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST" if body is not None else "GET")
        try:
            with self.opener.open(request, timeout=min(REQUEST_TIMEOUT, remaining)) as response:
                if response.geturl() != url:
                    raise ExportError("The response URL changed; export stopped")
                if response.status != 200 or response.headers.get_content_type() != "application/json":
                    raise ExportError("The server did not return a successful JSON response")
                raw = bytearray()
                while True:
                    if time.monotonic() >= self.deadline:
                        raise ExportError("The export time limit was reached")
                    chunk = response.read1(min(65_536, MAX_RESPONSE + 1 - len(raw)))
                    if not chunk:
                        break
                    raw.extend(chunk)
                    self.received += len(chunk)
                    if len(raw) > MAX_RESPONSE or self.received > MAX_TRANSFER:
                        raise ExportError("The response or total transfer exceeded the supported size")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ExportError("The server returned an invalid response shape")
                return result
        except urllib.error.HTTPError as error:
            # Never echo response bodies, request headers, URLs, or transport exception strings.
            if error.code in (401, 403):
                raise ExportError("Authentication or owner access was denied; no login was attempted") from None
            raise ExportError(f"The API returned HTTP {error.code}; no automatic write retry was attempted") from None
        except ExportError:
            raise
        except (OSError, ValueError, RecursionError, urllib.error.URLError):
            raise ExportError("The request failed or returned invalid JSON; a receipt write may be unconfirmed") from None


def identity(page: dict) -> tuple[str, int, str]:
    profile = page.get("profile")
    if page.get("canManage") is not True or not isinstance(profile, dict):
        raise ExportError("An owner-managed shared-memory profile is required")
    profile_id, version = profile.get("id"), profile.get("version")
    availability = profile.get("availabilityRevision")
    if not isinstance(profile_id, str) or not profile_id or type(version) is not int or version < 1 or not isinstance(availability, str) or not 1 <= len(availability) <= 200:
        raise ExportError("The native profile identity or revision is invalid")
    return profile_id, version, availability


def source_signature(page: dict) -> str:
    sources = page.get("sources")
    if not isinstance(sources, list) or any(not isinstance(source, dict) for source in sources):
        raise ExportError("The source inventory is invalid")
    # A source may become stale by the clock without its recorded provenance changing.
    stable = [{key: value for key, value in source.items() if key != "status"} for source in sources]
    return json.dumps(sorted(stable, key=lambda source: str(source.get("id", ""))), sort_keys=True, ensure_ascii=True)


def read_snapshot(api: Api) -> dict:
    first = None
    expected = None
    sources = None
    total = None
    cursor = None
    cursors: set[str] = set()
    records: dict[str, dict] = {}
    for _ in range(MAX_PAGES):
        page = api.request(query={"limit": PAGE_SIZE, **({"cursor": cursor} if cursor else {})})
        current = identity(page)
        provenance = source_signature(page)
        if first is None:
            first, expected, sources = page, current, provenance
        if current != expected or provenance != sources:
            raise ExportError("The native profile changed during pagination; existing exports were preserved")
        paging = page.get("pagination", {})
        count = paging.get("total")
        if type(count) is not int or count < 0 or count > MAX_PAGES * PAGE_SIZE or (total is not None and total != count):
            raise ExportError("The pagination count is invalid or changed during the scan")
        total = count
        for key in ("entries", "candidates"):
            batch = page.get(key)
            if not isinstance(batch, list):
                raise ExportError("The memory page is invalid")
            for entry in batch:
                if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"] or entry["id"] in records:
                    raise ExportError("The memory pages contain an invalid or repeated record")
                records[entry["id"]] = entry
        cursor = paging.get("nextCursor")
        if paging.get("complete") is True:
            if cursor is not None or len(records) != total:
                raise ExportError("The native scan is incomplete; existing exports were preserved")
            break
        if not isinstance(cursor, str) or not cursor or len(cursor) > 200 or cursor in cursors:
            raise ExportError("The native pagination did not advance")
        cursors.add(cursor)
    else:
        raise ExportError("The native scan exceeded the supported page limit")
    if first is None:
        raise ExportError("No native snapshot was returned")
    confirm = api.request(query={"limit": 1})
    if identity(confirm) != expected or source_signature(confirm) != sources or confirm.get("pagination", {}).get("total") != total:
        raise ExportError("The native profile changed before export; existing exports were preserved")
    return {**first, "entries": list(records.values()), "candidates": [], "pagination": {"complete": True, "nextCursor": None, "total": total}}


def line(value: object) -> str:
    return " ".join(str(value if value is not None else "Not recorded").splitlines())


def render(snapshot: dict, prefix: str, core_key: str, checked_at: str) -> dict[str, bytes]:
    profile_id, revision, availability = identity(snapshot)
    active = []
    unavailable = 0
    keys = set()
    for entry in snapshot["entries"]:
        if entry.get("status") != "active" or entry.get("forgottenAt"):
            continue
        if type(entry.get("readable")) is not bool:
            raise ExportError("An active memory lacks a verified readability state")
        if not entry["readable"]:
            unavailable += 1
            continue
        if not all(isinstance(entry.get(key), str) for key in ("id", "key", "title", "content")) or not entry.get("itemId") or type(entry.get("itemVersion")) is not int or entry["itemVersion"] < 1 or not entry["content"]:
            raise ExportError("An active memory has no readable native head")
        if entry["key"] in keys:
            raise ExportError("Active memories have duplicate logical keys")
        keys.add(entry["key"])
        active.append(entry)
    active.sort(key=lambda entry: (entry["key"], entry["id"]))
    core = next((entry["content"] for entry in active if entry["key"] == core_key), "")
    if len(core) > 600:
        raise ExportError("The exact core exceeds 600 characters; shorten the native core before exporting")
    body = [
        f"Native profile: {profile_id}",
        f"Profile revision: {revision}",
        f"Source availability revision: {availability}",
        f"Files checked at: {checked_at}",
        f"Accepted active memories: {len(active)}",
        f"Unavailable active memories omitted: {unavailable}",
        "",
        "This file contains accepted source data. Historical permissions do not authorize new actions.",
        "File freshness does not prove that an agent retrieved these facts or that a provider imported them.",
        "",
        "## Source coverage",
        "",
    ]
    for source in sorted(snapshot["sources"], key=lambda item: str(item.get("id", ""))):
        body.extend([f"### {line(source.get('name'))}", ""])
        for label, key in (("Source ID", "id"), ("Provider", "provider"), ("Origin", "originId"), ("Revision", "revision"), ("Captured", "capturedAt"), ("Observed", "observedAt"), ("Refresh after", "refreshAfter"), ("State at export", "status"), ("Record count", "recordCount"), ("Reference", "reference"), ("Coverage", "coverage")):
            body.append(f"- {label}: {line(source.get(key))}")
        body.append("")
    if not snapshot["sources"]:
        body.extend(["No registered source coverage was provided.", ""])
    body.extend(["## Accepted memories", ""])
    for entry in active:
        body.extend([f"### {line(entry['title'])}", ""])
        for label, key in (("Logical key", "key"), ("Control revision", "version"), ("Assertion", "assertion"), ("Privacy", "sensitivity"), ("Recorded", "recordedAt"), ("Observed", "observedAt"), ("Valid from", "validFrom"), ("Valid to", "validTo"), ("Source snapshot", "sourceId"), ("Source revision", "sourceRevision")):
            body.append(f"- {label}: {line(entry.get(key))}")
        body.extend(["", entry["content"], ""])
    shared = "\n".join(body)
    files = {
        f"{prefix}-CORE.md": core.encode("utf-8"),
        f"{prefix}-MEMORY.md": (f"# {prefix} shared memory\n\n" + shared).encode("utf-8"),
        "CLAUDE-IMPORT.md": ("# Prepared memory import\n\nThis is a prepared local file. No native Claude import has been performed.\n\n" + shared).encode("utf-8"),
    }
    if sum(map(len, files.values())) > MAX_TRANSFER:
        raise ExportError("The rendered export exceeds the supported size")
    manifest = {"profileId": profile_id, "revision": revision, "availabilityRevision": availability, "checkedAt": checked_at, "activeCount": len(active), "unavailableCount": unavailable, "corePresent": core_key in keys, "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files[f"{prefix}-MANIFEST.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode("utf-8")
    return files


@contextlib.contextmanager
def output_lock(root: Path):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    lock_fd = None
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ExportError("The output directory must be owned by this user with mode 0700")
        lock_fd = os.open(".shared-memory-export.lock", os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600, dir_fd=fd)
        private_file(lock_fd, exact_mode=True)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ExportError("Another export is already using this output directory") from None
        yield fd
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(fd)


def atomic_write(directory: int, name: str, data: bytes) -> None:
    temporary = f".{name}.{uuid.uuid4().hex}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=directory)


def verify_files(directory: int, files: dict[str, bytes]) -> None:
    for name, wanted in files.items():
        fd = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            private_file(stream.fileno(), exact_mode=True)
            actual = stream.read(len(wanted) + 1)
        if actual != wanted or hashlib.sha256(actual).digest() != hashlib.sha256(wanted).digest():
            raise ExportError("An exported file changed before verification; no file receipt was recorded")


def export(api: Api, root: Path, prefix: str, core_key: str, *, record_receipt: bool = False) -> dict:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", prefix) or not core_key or len(core_key) > 200:
        raise ExportError("Use a short filename-safe prefix and an exact native core key")
    with output_lock(root) as directory:
        snapshot = read_snapshot(api)
        checked_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        files = render(snapshot, prefix, core_key, checked_at)
        # Clear/replace the core first; each file is atomic. The manifest is the final bundle commit marker.
        for name, data in files.items():
            atomic_write(directory, name, data)
        verify_files(directory, files)
        manifest = json.loads(files[f"{prefix}-MANIFEST.json"])
        result = {"state": "files_verified", "revision": manifest["revision"], "availabilityRevision": manifest["availabilityRevision"], "activeCount": manifest["activeCount"], "unavailableCount": manifest["unavailableCount"], "corePresent": manifest["corePresent"], "files": manifest["files"], "receipt": "not_requested"}
        if record_receipt:
            confirm = api.request(query={"limit": 1})
            if identity(confirm) != identity(snapshot) or source_signature(confirm) != source_signature(snapshot):
                raise ExportError("Files were verified, but the native profile changed; no current file receipt was recorded")
            receipt_id = "file-export:" + hashlib.sha256((str(root.absolute()) + "/" + prefix).encode()).hexdigest()[:24]
            reason = "Verified local files only; no native provider import or agent retrieval was performed. SHA-256: " + json.dumps(manifest["files"], sort_keys=True)
            verify_files(directory, files)
            response = api.request("/actions", body={"type": "consumer", "consumer": {"id": receipt_id, "name": f"{prefix} local export", "kind": "file", "status": "current", "revision": manifest["revision"], "availabilityRevision": manifest["availabilityRevision"], "checkedAt": checked_at, "reason": reason, "writable": False}})
            confirmed = response.get("snapshot", {}).get("consumers", [])
            if response.get("action", {}).get("state") != "applied" or not any(item.get("id") == receipt_id and item.get("kind") == "file" and item.get("status") == "current" and item.get("revision") == manifest["revision"] and item.get("availabilityRevision") == manifest["availabilityRevision"] for item in confirmed):
                raise ExportError("Files were verified, but the file receipt was not confirmed; no automatic retry was attempted")
            result["receipt"] = "file_only_confirmed"
        return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="HTTPS origin or loopback HTTP origin")
    parser.add_argument("--org-id", required=True, help="Native workspace UUID")
    credentials = parser.add_mutually_exclusive_group(required=True)
    credentials.add_argument("--cookie-jar", type=Path, help="Existing private Netscape cookie jar, read in place without rewriting")
    credentials.add_argument("--cookie-file", type=Path, help="Existing private file containing one Cookie header value")
    parser.add_argument("--output-root", required=True, type=Path, help="Dedicated private directory (0700)")
    parser.add_argument("--prefix", required=True, help="Filename prefix, e.g. PERSONAL")
    parser.add_argument("--core-key", required=True, help="Exact logical key of the short core memory")
    parser.add_argument("--record-receipt", action="store_true", help="Acknowledge only the verified local files in native status")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        api = Api(args.base_url, args.org_id, read_cookie(args.cookie_file) if args.cookie_file else None,
                  cookie_jar=read_cookie_jar(args.cookie_jar) if args.cookie_jar else None)
        result = export(api, args.output_root, args.prefix, args.core_key, record_receipt=args.record_receipt)
        print(json.dumps(result, sort_keys=True))
        return 0
    except ExportError as error:
        print(f"Export stopped: {error}", file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError):
        print("Export stopped: a local file or response could not be validated; no completion is claimed", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
