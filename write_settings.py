#!/usr/bin/python3
"""Merge parameters into the widget's entry in shell.json.

Widget parameters live as FLAT keys on the layout entry (like stock widgets,
e.g. omarchy.clock's `format`), not under a nested `settings` object. The shell
strips only `id` and hands the rest to the widget as its `settings`, so the
entry must be:

    { "id": "davidjm.rain", "density": 3, "lightning": true }

The shell watches shell.json (atomic writes only), and when just widget
settings changed it patches live widgets in place, so a successful run updates
the running rain without rebuilding anything.

Usage:
    /usr/bin/python3 write_settings.py '{"density": 3}'   # merge these keys

Security: config-write boundary. The config path may sit under influenceable
directory state, so this helper:
  - walks the parent directory components with O_NOFOLLOW|O_DIRECTORY, so no
    symlinked parent is ever followed;
  - opens the existing shell.json once through a no-follow, nonblocking
    descriptor and, from fstat on that descriptor, refuses anything that is
    not a regular file owned by the current user with a single hard link and
    a size at or below MAX_CONFIG_BYTES; it then reads at most
    MAX_CONFIG_BYTES+1 bytes;
  - writes a randomized same-directory temporary file created with
    O_CREAT|O_EXCL|O_NOFOLLOW, fsyncs it, and atomically replaces the
    validated destination. No fixed, guessable `.tmp` name is ever used.
"""

import base64
import fcntl
import json
import math
import os
import re
import stat
import sys

PLUGIN_ID = "davidjm.rain"
CONFIG_DIR = os.path.expanduser("~/.config/omarchy")
CONFIG_NAME = "shell.json"
CONFIG_PATH = os.path.join(CONFIG_DIR, CONFIG_NAME)
LOCK_NAME = ".shell.json.lock"
JOURNAL_NAME = ".shell.json.transaction.json"
LEGACY_JOURNAL_NAME = ".bar-editor.transaction.json"
BACKUP_SUFFIX = ".bak-editor"
MAX_CONFIG_BYTES = 1 << 20  # 1 MiB; the real config is a few KiB
MAX_JOURNAL_BYTES = 8 << 20
MAX_SELECTOR_BYTES = 65536
INSTANCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$")

EFFECTS = {
    "Rain",
    "Snow",
    "Ripples",
    "Dust",
    "Fireflies",
    "Leaves",
    "Aurora",
    "Embers",
    "Bubbles",
    "Confetti",
    "Caustics",
    "Light Shafts",
}
NUMERIC_LIMITS = {
    "density": (1.0, 3.0),
    "speed": (0.5, 3.0),
    "fps": (15.0, 60.0),
    "quality": (0.5, 2.0),
    "straightness": (0.0, 2.0),
}
BOOLEAN_KEYS = {"running", "lightning", "audio"}
ENUM_KEYS = {
    "effect": EFFECTS,
    "variant": {"autumn", "cherry"},
    "corner": {"tl", "tr", "bl", "br"},
}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def open_config_dir() -> int:
    try:
        return open_dir_no_follow(CONFIG_DIR)
    except OSError:
        fail("refusing to traverse %s (symlinked or unreadable path)" % CONFIG_DIR)


def open_dir_no_follow(path: str) -> int:
    """Open a directory tree from / without following any symlink component."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    for part in path.split(os.sep):
        if not part:
            continue
        try:
            nxt = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=fd,
            )
        except OSError:
            os.close(fd)
            raise
        os.close(fd)
        fd = nxt
    return fd


def acquire_lock(dirfd: int) -> int:
    try:
        fd = os.open(
            LOCK_NAME,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=dirfd,
        )
    except OSError:
        fail("could not open the Rain settings lock safely")
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail("Rain settings lock is not a regular file; refusing")
        if st.st_uid != os.geteuid():
            fail("Rain settings lock is not owned by the current user; refusing")
        if st.st_nlink != 1 or stat.S_IMODE(st.st_mode) & 0o022:
            fail("Rain settings lock is unsafe; refusing")
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd
    except Exception:
        os.close(fd)
        raise


def read_optional_entry(dirfd: int, name: str, limit: int):
    fd = None
    try:
        try:
            fd = os.open(
                name,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                dir_fd=dirfd,
            )
        except FileNotFoundError:
            return b"", 0o600, False
        except OSError:
            fail("could not read %s safely" % name)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            fail("%s is not a regular file; refusing" % name)
        if before.st_uid != os.geteuid():
            fail("%s is not owned by the current user; refusing" % name)
        if before.st_nlink != 1 or stat.S_IMODE(before.st_mode) & 0o022:
            fail("%s is unsafe; refusing" % name)
        if before.st_size > limit:
            fail("%s exceeds the %d-byte limit; refusing" % (name, limit))
        with os.fdopen(fd, "rb") as raw:
            blob = raw.read(limit + 1)
            after = os.fstat(raw.fileno())
        fd = None
        if (len(blob) > limit or before.st_dev != after.st_dev or before.st_ino != after.st_ino
                or before.st_size != after.st_size
                or getattr(before, "st_mtime_ns", int(before.st_mtime * 1000000000))
                != getattr(after, "st_mtime_ns", int(after.st_mtime * 1000000000))):
            fail("%s changed while reading; refusing" % name)
        return blob, stat.S_IMODE(before.st_mode), True
    finally:
        if fd is not None:
            os.close(fd)


def read_existing_config(dirfd: int, with_mode: bool = False):
    blob, mode, exists = read_optional_entry(dirfd, CONFIG_NAME, MAX_CONFIG_BYTES)
    if not exists:
        fail("shell.json not found under %s; refusing" % CONFIG_DIR)
    try:
        data = json.loads(blob.decode("utf-8"), parse_constant=lambda value: fail("non-finite JSON number in shell.json"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("shell.json is not valid UTF-8 JSON; refusing")
    if not isinstance(data, dict):
        fail("shell.json root must be a JSON object; refusing")
    return (data, mode) if with_mode else data


def write_bytes(dirfd: int, name: str, data: bytes, mode: int, limit: int) -> None:
    if (not isinstance(data, bytes) or len(data) > limit or not name
            or name in (".", "..") or os.path.basename(name) != name
            or isinstance(mode, bool) or not isinstance(mode, int) or mode < 0 or mode > 0o7777):
        fail("invalid durable write")
    tmp_fd = None
    tmp_name = None
    try:
        for _ in range(100):
            candidate = ".%s.%s.tmp" % (name, os.urandom(8).hex())
            try:
                tmp_fd = os.open(
                    candidate,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                    dir_fd=dirfd,
                )
                tmp_name = candidate
                break
            except FileExistsError:
                continue
        if tmp_fd is None:
            fail("could not create a temporary file in %s; refusing" % CONFIG_DIR)
        with os.fdopen(tmp_fd, "wb") as raw:
            os.fchmod(raw.fileno(), mode & 0o7777)
            raw.write(data)
            raw.flush()
            os.fsync(raw.fileno())
        tmp_fd = None
        os.replace(tmp_name, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
        os.fsync(dirfd)
        tmp_name = None
    finally:
        if tmp_fd is not None:
            os.close(tmp_fd)
        if tmp_name is not None:
            try:
                os.unlink(tmp_name, dir_fd=dirfd)
            except FileNotFoundError:
                pass


def write_config(dirfd: int, data, mode: int) -> None:
    try:
        payload = (json.dumps(data, indent=2, allow_nan=False) + "\n").encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        fail("shell.json contains a value that cannot be written safely")
    if len(payload) > MAX_CONFIG_BYTES:
        fail("updated shell.json exceeds the %d-byte limit; refusing" % MAX_CONFIG_BYTES)
    write_bytes(dirfd, CONFIG_NAME, payload, mode, MAX_CONFIG_BYTES)


def open_child_directory(dirfd: int, name: str, create: bool = False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=dirfd)
        except FileExistsError:
            pass
        except OSError:
            fail("could not create %s safely" % name)
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=dirfd,
        )
    except FileNotFoundError:
        return None
    except OSError:
        fail("could not open %s safely" % name)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
        os.close(fd)
        fail("%s is unsafe; refusing" % name)
    return fd


def secure_unlink_entry(dirfd: int, name: str) -> None:
    try:
        os.unlink(name, dir_fd=dirfd)
    except FileNotFoundError:
        pass
    os.fsync(dirfd)


def transaction_journal_paths():
    return [
        os.path.join(CONFIG_DIR, JOURNAL_NAME),
        os.path.join(CONFIG_DIR, LEGACY_JOURNAL_NAME),
    ]


def transaction_target_allowed(target: str) -> bool:
    root = os.path.abspath(CONFIG_DIR)
    target = os.path.abspath(target)
    allowed = {
        os.path.join(root, "shell.json"),
        os.path.join(root, "shell.toml"),
        os.path.join(root, "shell.json" + BACKUP_SUFFIX),
        os.path.join(root, "shell.toml" + BACKUP_SUFFIX),
    }
    if target in allowed:
        return True
    profile_root = os.path.join(root, "bar-profiles")
    if os.path.dirname(target) != profile_root:
        return False
    name = os.path.basename(target)
    if name.endswith(BACKUP_SUFFIX):
        name = name[:-len(BACKUP_SUFFIX)]
    return name.endswith(".json") and bool(PROFILE_RE.fullmatch(name[:-5]))


def target_parent(rootfd: int, target: str, create: bool = False):
    root = os.path.abspath(CONFIG_DIR)
    target = os.path.abspath(target)
    if not transaction_target_allowed(target):
        fail("invalid transaction target")
    if os.path.dirname(target) == root:
        return os.dup(rootfd), os.path.basename(target)
    return open_child_directory(rootfd, "bar-profiles", create), os.path.basename(target)


def read_target(rootfd: int, target: str, limit: int):
    parentfd, name = target_parent(rootfd, target)
    if parentfd is None:
        return b"", 0o600, False
    try:
        return read_optional_entry(parentfd, name, limit)
    finally:
        os.close(parentfd)


def write_target(rootfd: int, target: str, data: bytes, mode: int, limit: int) -> None:
    parentfd, name = target_parent(rootfd, target, True)
    if parentfd is None:
        fail("could not open transaction target directory")
    try:
        write_bytes(parentfd, name, data, mode, limit)
    finally:
        os.close(parentfd)


def remove_target(rootfd: int, target: str) -> None:
    parentfd, name = target_parent(rootfd, target, True)
    if parentfd is None:
        return
    try:
        secure_unlink_entry(parentfd, name)
    finally:
        os.close(parentfd)


def decode_journal_bytes(value, exists: bool) -> bytes:
    if not exists:
        return b""
    if not isinstance(value, str) or len(value) > ((MAX_CONFIG_BYTES * 4) // 3 + 8):
        fail("invalid transaction journal")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (ValueError, UnicodeError):
        fail("invalid transaction journal")
    if len(raw) > MAX_CONFIG_BYTES:
        fail("invalid transaction journal")
    return raw


def journal_operations(rootfd: int, journal: str):
    name = os.path.basename(journal)
    if os.path.dirname(os.path.abspath(journal)) != os.path.abspath(CONFIG_DIR) or name not in (
        JOURNAL_NAME,
        LEGACY_JOURNAL_NAME,
    ):
        fail("invalid transaction journal")
    try:
        os.stat(name, dir_fd=rootfd, follow_symlinks=False)
    except FileNotFoundError:
        return []
    except OSError:
        fail("invalid transaction journal")
    content, mode, exists = read_optional_entry(rootfd, name, MAX_JOURNAL_BYTES)
    if not exists:
        return []
    if mode & 0o077:
        fail("invalid transaction journal")
    try:
        data = json.loads(content.decode("utf-8"), parse_constant=lambda value: fail("invalid transaction journal"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
        fail("invalid transaction journal")
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("operations"), list):
        fail("invalid transaction journal")
    if len(data["operations"]) > 16:
        fail("invalid transaction journal")
    operations = []
    seen = set()
    reserved = set(transaction_journal_paths())
    reserved.add(os.path.join(CONFIG_DIR, LOCK_NAME))
    for item in data["operations"]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            fail("invalid transaction journal")
        target = os.path.abspath(item["path"])
        if (len(target) > 4096 or "\x00" in target or target in seen or target in reserved
                or not transaction_target_allowed(target)):
            fail("invalid transaction journal")
        seen.add(target)
        file_mode = item.get("mode")
        exists = item.get("exists")
        backup_exists = item.get("backup_exists")
        if (isinstance(file_mode, bool) or not isinstance(file_mode, int)
                or file_mode < 0 or file_mode > 0o7777
                or not isinstance(exists, bool) or not isinstance(backup_exists, bool)):
            fail("invalid transaction journal")
        operations.append({
            "path": target,
            "mode": file_mode,
            "exists": exists,
            "old": decode_journal_bytes(item.get("old"), exists),
            "backup_exists": backup_exists,
            "backup": decode_journal_bytes(item.get("backup"), backup_exists),
        })
    return operations


def restore_operations(rootfd: int, operations) -> None:
    for item in reversed(operations):
        target = item["path"]
        if item["exists"]:
            write_target(rootfd, target, item["old"], item["mode"], MAX_CONFIG_BYTES)
        else:
            remove_target(rootfd, target)
        backup = target + BACKUP_SUFFIX
        if item["backup_exists"]:
            write_target(rootfd, backup, item["backup"], item["mode"], MAX_CONFIG_BYTES)
        else:
            remove_target(rootfd, backup)


def recover_pending_transaction(rootfd: int) -> bool:
    recovered = False
    for journal in transaction_journal_paths():
        operations = journal_operations(rootfd, journal)
        if operations:
            restore_operations(rootfd, operations)
            secure_unlink_entry(rootfd, os.path.basename(journal))
            recovered = True
        else:
            try:
                os.stat(os.path.basename(journal), dir_fd=rootfd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            secure_unlink_entry(rootfd, os.path.basename(journal))
    return recovered


def make_journal(rootfd: int, entries, journal: str):
    try:
        os.stat(os.path.basename(journal), dir_fd=rootfd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        fail("transaction journal already exists")
    operations = []
    seen = set()
    for target, content in entries:
        target = os.path.abspath(target)
        if target in seen or not transaction_target_allowed(target) or not isinstance(content, bytes):
            fail("invalid transaction target")
        if len(content) > MAX_CONFIG_BYTES:
            fail("invalid transaction content")
        seen.add(target)
        old, mode, exists = read_target(rootfd, target, MAX_CONFIG_BYTES)
        backup, _, backup_exists = read_target(rootfd, target + BACKUP_SUFFIX, MAX_CONFIG_BYTES)
        operations.append({
            "path": target,
            "mode": mode,
            "exists": exists,
            "old": old if exists else None,
            "backup_exists": backup_exists,
            "backup": backup if backup_exists else None,
        })
    payload_operations = []
    for item in operations:
        payload_operations.append({
            "path": item["path"],
            "mode": item["mode"],
            "exists": item["exists"],
            "old": base64.b64encode(item["old"]).decode("ascii") if item["exists"] else None,
            "backup_exists": item["backup_exists"],
            "backup": base64.b64encode(item["backup"]).decode("ascii") if item["backup_exists"] else None,
        })
    try:
        payload = json.dumps(
            {"version": 1, "operations": payload_operations},
            ensure_ascii=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        fail("could not encode transaction journal")
    if len(payload) > MAX_JOURNAL_BYTES:
        fail("transaction journal is too large")
    write_bytes(rootfd, os.path.basename(journal), payload, 0o600, MAX_JOURNAL_BYTES)
    return operations


def write_transaction(rootfd: int, data, mode: int) -> None:
    try:
        payload = (json.dumps(data, indent=2, allow_nan=False) + "\n").encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        fail("shell.json contains a value that cannot be written safely")
    if len(payload) > MAX_CONFIG_BYTES:
        fail("updated shell.json exceeds the %d-byte limit; refusing" % MAX_CONFIG_BYTES)
    journal = transaction_journal_paths()[0]
    operations = make_journal(rootfd, [(CONFIG_PATH, payload)], journal)
    prior = operations[0]
    try:
        old, current_mode, exists = read_target(rootfd, CONFIG_PATH, MAX_CONFIG_BYTES)
        if exists != prior["exists"] or old != prior["old"] or current_mode != prior["mode"] or current_mode != mode:
            fail("transaction source changed")
        write_bytes(rootfd, CONFIG_NAME, payload, mode, MAX_CONFIG_BYTES)
        actual, actual_mode, actual_exists = read_target(rootfd, CONFIG_PATH, MAX_CONFIG_BYTES)
        if not actual_exists or actual != payload or actual_mode != mode:
            fail("write verification failed")
    except BaseException:
        try:
            restore_operations(rootfd, operations)
            secure_unlink_entry(rootfd, os.path.basename(journal))
        except BaseException:
            pass
        raise
    secure_unlink_entry(rootfd, os.path.basename(journal))


def validate_changes(changes) -> dict:
    if not isinstance(changes, dict) or not changes:
        fail("settings changes must be a non-empty JSON object")
    if len(changes) > 16:
        fail("too many settings changes in one write")
    validated = {}
    for key, value in changes.items():
        if key == "id":
            fail("id is managed by the bar layout and cannot be changed")
        if key == "instanceId":
            if not isinstance(value, str) or not INSTANCE_ID_RE.fullmatch(value):
                fail("instanceId is invalid")
            validated[key] = value
            continue
        if key in BOOLEAN_KEYS:
            if type(value) is not bool:
                fail("%s must be a boolean" % key)
            validated[key] = value
            continue
        if key in ENUM_KEYS:
            if not isinstance(value, str) or value not in ENUM_KEYS[key]:
                fail("invalid value for %s" % key)
            validated[key] = value
            continue
        if key in NUMERIC_LIMITS:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                fail("%s must be a finite number" % key)
            number = float(value)
            if not math.isfinite(number):
                fail("%s must be a finite number" % key)
            minimum, maximum = NUMERIC_LIMITS[key]
            if number < minimum or number > maximum:
                fail("%s must be between %g and %g" % (key, minimum, maximum))
            validated[key] = int(value) if type(value) is int else number
            continue
        fail("unsupported Rain setting: %s" % key)
    return validated


def parse_selector(raw: str) -> dict:
    if not raw:
        return {}
    if len(raw.encode("utf-8")) > MAX_SELECTOR_BYTES:
        fail("Rain settings selector is too large")
    try:
        selector = json.loads(raw, parse_constant=lambda value: fail("non-finite selector value"))
    except json.JSONDecodeError:
        fail("Rain settings selector is not valid JSON")
    if not isinstance(selector, dict):
        fail("Rain settings selector must be a JSON object")
    allowed = {"region", "index", "entry", "instanceId"}
    if any(key not in allowed for key in selector):
        fail("Rain settings selector contains an unsupported field")
    region = selector.get("region")
    index = selector.get("index")
    entry = selector.get("entry")
    instance_id = selector.get("instanceId")
    if region is not None and region not in ("left", "center", "right"):
        fail("Rain settings selector has an invalid region")
    if index is not None and (type(index) is not int or index < 0):
        fail("Rain settings selector has an invalid index")
    if entry is not None:
        if not isinstance(entry, dict) or entry.get("id") != PLUGIN_ID:
            fail("Rain settings selector has an invalid entry")
    if instance_id is not None and (not isinstance(instance_id, str) or not INSTANCE_ID_RE.fullmatch(instance_id)):
        fail("Rain settings selector has an invalid instanceId")
    if (region is None) != (index is None):
        fail("Rain settings selector must include both region and index")
    if not selector:
        fail("Rain settings selector must not be empty")
    return selector


def find_layout(layout: dict, selector: dict):
    for region in ("left", "center", "right"):
        entries = layout.get(region)
        if not isinstance(entries, list):
            fail("bar.layout.%s must be a JSON array; refusing" % region)

    positions = []
    for region in ("left", "center", "right"):
        for index, entry in enumerate(layout[region]):
            if isinstance(entry, dict) and entry.get("id") == PLUGIN_ID:
                positions.append((region, index, entry))

    if selector:
        region = selector["region"]
        index = selector["index"]
        expected = selector.get("entry")
        instance_id = selector.get("instanceId")
        selected = None
        if index < len(layout[region]):
            candidate = layout[region][index]
            if isinstance(candidate, dict) and candidate.get("id") == PLUGIN_ID:
                selected = candidate
        if instance_id is not None:
            matches = [entry for _, _, entry in positions if entry.get("instanceId") == instance_id]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                fail("duplicate Rain instanceId; refusing an ambiguous write")
            if selected is not None and expected is not None and selected == expected:
                return selected
            fail("Rain widget instance changed before the settings write; retry")
        if selected is None:
            fail("Rain widget instance is no longer present at the selected position")
        if expected is not None and selected != expected:
            fail("Rain widget instance changed before the settings write; retry")
        return selected

    if not positions:
        fail("%s not found in bar layout" % PLUGIN_ID)
    if len(positions) != 1:
        fail("multiple Rain widget instances exist; an instance selector is required")
    return positions[0][2]


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        fail("usage: write_settings.py '<changes-json>' ['<selector-json>']")
    try:
        raw_changes = json.loads(
            sys.argv[1],
            parse_constant=lambda value: fail("non-finite settings value"),
        )
    except json.JSONDecodeError:
        fail("settings changes are not valid JSON")
    changes = validate_changes(raw_changes)
    selector = parse_selector(sys.argv[2] if len(sys.argv) > 2 else "")

    dirfd = open_config_dir()
    lockfd = acquire_lock(dirfd)
    try:
        recover_pending_transaction(dirfd)
        data, mode = read_existing_config(dirfd, True)
        bar = data.get("bar")
        if not isinstance(bar, dict):
            fail("shell.json bar must be a JSON object; refusing")
        layout = bar.get("layout")
        if not isinstance(layout, dict):
            fail("shell.json bar.layout must be a JSON object; refusing")
        entry = find_layout(layout, selector)
        entry.update(changes)
        write_transaction(dirfd, data, mode)
    finally:
        fcntl.flock(lockfd, fcntl.LOCK_UN)
        os.close(lockfd)
        os.close(dirfd)
    print("ok")


if __name__ == "__main__":
    main()