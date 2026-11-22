#!/usr/bin/env python3
"""Atomic admission for full local AC CI. No network, no GitHub, no force unlocks.

Every managed entrant uses the same kernel flock admission gate. Candidate
owner records are written before an atomic hard-link to the destination, so a
crash cannot leave an ownerless new lock. Recovery only unlinks provably dead
owner records, under the same admission gate.
"""
import fcntl
import os
import pathlib
import sys
import tempfile
import uuid

def record(path):
    p = pathlib.Path(path)
    try:
        content = (p / "owner" if p.is_dir() else p).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return {}
    out = {}
    for line in content.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v
    return out

def alive(pid):
    try:
        value = int(pid)
        if value < 1:
            return False
        os.kill(value, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (ValueError, TypeError):
        return False

def realpath(path):
    return os.path.realpath(path) if path else ""

def occupied_legacy(path):
    p = pathlib.Path(path)
    if not p.exists():
        return False, ""
    owner = record(p)
    # Unknown ownership is occupied: we must not discard another writer's lock.
    if not owner.get("pid"):
        return True, realpath(owner.get("dir"))
    return alive(owner["pid"]), realpath(owner.get("dir"))

def unverified_owner(path):
    """An ambiguous lock is a hard operator/reconciliation gate, never a retry."""
    p = pathlib.Path(path)
    if not p.exists():
        return False
    owner = record(p)
    if not owner.get("pid"):
        return True
    if p.is_file():
        return not owner.get("token") or not owner.get("dir")
    if p.is_dir():
        try:
            return sorted(x.name for x in p.iterdir()) != ["owner"]
        except OSError:
            return True
    return True


def remove_provably_dead(path, recovered):
    """Only new-style *files* or a proven dead legacy owner directory."""
    p = pathlib.Path(path)
    if not p.exists():
        return
    owner = record(p)
    pid = owner.get("pid")
    if not pid or alive(pid):
        return
    if p.is_file():
        # Only reclaim a known new-style atomic owner record; arbitrary files
        # carrying an old PID are not disposable CI locks.
        if not owner.get("token") or not owner.get("dir"):
            return
        try:
            p.unlink()
            recovered.append(pid)
        except OSError:
            pass
    elif p.is_dir():
        # A legacy directory may only contain the exact known owner file.
        try:
            if sorted(x.name for x in p.iterdir()) != ["owner"]:
                return
            quarantine = p.with_name(p.name + ".stale." + uuid.uuid4().hex)
            p.rename(quarantine)
            (quarantine / "owner").unlink()
            quarantine.rmdir()
            recovered.append(pid)
        except OSError:
            pass

def atomic_claim(path, data):
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ci-owner-", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as h:
            h.write(data)
            h.flush()
            os.fsync(h.fileno())
        # Atomic no-replace; unlike the ln CLI, os.link never enters a directory.
        os.link(tmp, p)
        return True
    except FileExistsError:
        return False
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass

def release_ours(path, pid, token):
    p = pathlib.Path(path)
    if not p.is_file():
        return
    owner = record(p)
    if owner.get("pid") == str(pid) and owner.get("token") == token:
        p.unlink()

def status(root, scope, worktree, max_parallel, legacy_excluded, recovered):
    """Count all live new slots; legacy direct runners are non-cooperative."""
    legacy_count = 0
    legacy_same = False
    global_active = False
    global_path = root / "ci.lock"
    if unverified_owner(global_path):
        raise ValueError("unverified_legacy_global_lock: manual reconciliation required: " + str(global_path))
    global_active, global_scope = occupied_legacy(global_path)
    if global_active:
        legacy_count += 1
        legacy_same |= global_scope == scope
    for p in (root / "parallel-worktrees").glob("*.lock"):
        if str(p) == str(worktree):
            continue
        if unverified_owner(p):
            raise ValueError("unverified_legacy_transition_lock: manual reconciliation required: " + str(p))
        used, old_scope = occupied_legacy(p)
        if used:
            legacy_count += 1
            legacy_same |= old_scope == scope

    active_slots = 0
    slot_root = root / "ci-slots"
    for p in slot_root.glob("slot-*.lock"):
        remove_provably_dead(p, recovered)
        if unverified_owner(p):
            raise ValueError("unverified_host_slot: manual reconciliation required: " + str(p))
        if p.exists():
            active_slots += 1

    # An unmanaged old global CI can start without this admission gate.
    # Reserve one place unless the operator has verified it cannot start.
    reserve = 0 if (legacy_excluded or global_active) else 1
    return legacy_count + active_slots + reserve, legacy_same, legacy_count, active_slots, reserve

def acquire(root, scope, worktree, max_parallel, pid, label, legacy_excluded):
    recovered = []
    remove_provably_dead(worktree, recovered)
    if unverified_owner(worktree):
        raise ValueError("unverified_worktree_lock: manual reconciliation required: " + str(worktree))
    if pathlib.Path(worktree).exists():
        old = record(worktree)
        print("BUSY=worktree busy, pid=" + old.get("pid", "unknown"))
        return 1
    used, same, legacy, active, reserve = status(
        root, scope, worktree, max_parallel, legacy_excluded, recovered
    )
    if same:
        print("BUSY=same worktree has a legacy running CI")
        return 1
    if used >= max_parallel:
        print("BUSY=parallel limit reached (existing=%d, legacy=%d, slots=%d, reserved=%d)" %
              (used, legacy, active, reserve))
        return 1

    slot = None
    for i in range(1, max_parallel + 1):
        candidate = root / "ci-slots" / ("slot-%d.lock" % i)
        remove_provably_dead(candidate, recovered)
        if not candidate.exists():
            slot = candidate
            break
    if slot is None:
        print("BUSY=all parallel slots occupied")
        return 1

    token = uuid.uuid4().hex
    owner = "pid=%s\nlabel=%s\ndir=%s\ntoken=%s\n" % (
        pid, label.replace("\n", " "), scope, token
    )
    if not atomic_claim(worktree, owner):
        print("BUSY=worktree claimed during admission")
        return 1
    try:
        if not atomic_claim(slot, owner):
            print("BUSY=slot was claimed during admission")
            return 1
        # All cooperative claimers take the same flock; only unmanaged legacy
        # starts can race. Our reserve accounts for the old global entrypoint.
        print("WORKTREE=" + str(worktree))
        print("SLOT=" + str(slot))
        print("TOKEN=" + token)
        print("CAPACITY=%d/%d" % (used + 1, max_parallel))
        for old in recovered:
            print("RECOVERED=" + old)
        return 0
    finally:
        if record(slot).get("token") != token:
            release_ours(worktree, pid, token)

def run():
    if len(sys.argv) < 2:
        return 2
    verb = sys.argv[1]
    if verb == "acquire":
        if len(sys.argv) != 10:
            return 2
        _, _, root_raw, scope_raw, worktree_raw, cap_raw, pid_raw, label, excluded_raw, _ = sys.argv
        # final unused positional parameter reserved for future compatibility.
        if excluded_raw not in ("0", "1"):
            return 2
        try:
            cap = int(cap_raw)
            pid = int(pid_raw)
        except ValueError:
            return 2
        if cap not in (1, 2, 3, 4) or pid < 1:
            return 2
        root = pathlib.Path(root_raw).resolve()
        scope = realpath(scope_raw)
        worktree = pathlib.Path(worktree_raw)
        root.mkdir(parents=True, exist_ok=True)
        with (root / "ci-admission.guard").open("a+") as gate:
            fcntl.flock(gate.fileno(), fcntl.LOCK_EX)
            return acquire(root, scope, worktree, cap, pid, label, excluded_raw == "1")
    if verb == "release":
        if len(sys.argv) != 7:
            return 2
        _, _, root_raw, worktree_raw, slot_raw, pid_raw, token = sys.argv
        root = pathlib.Path(root_raw).resolve()
        with (root / "ci-admission.guard").open("a+") as gate:
            fcntl.flock(gate.fileno(), fcntl.LOCK_EX)
            release_ours(slot_raw, int(pid_raw), token)
            release_ours(worktree_raw, int(pid_raw), token)
        return 0
    return 2

if __name__ == "__main__":
    try:
        sys.exit(run())
    except (OSError, ValueError) as exc:
        print("ERROR=" + type(exc).__name__ + ":" + str(exc)[:160])
        sys.exit(2)
