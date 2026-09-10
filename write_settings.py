#!/usr/bin/env python3
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
    python3 write_settings.py '{"density": 3}'            # merge these keys

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

import json
import os
import stat
import sys

PLUGIN_ID = "davidjm.rain"
CONFIG_DIR = os.path.expanduser("~/.config/omarchy")
CONFIG_NAME = "shell.json"
CONFIG_PATH = os.path.join(CONFIG_DIR, CONFIG_NAME)
MAX_CONFIG_BYTES = 1 << 20  # 1 MiB; the real config is a few KiB


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


def read_existing_config():
    """Open shell.json once via a no-follow/nonblocking descriptor and parse it."""
    dirfd = open_config_dir()
    fd = None
    try:
        try:
            fd = os.open(
                CONFIG_NAME,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                dir_fd=dirfd,
            )
        except FileNotFoundError:
            fail("shell.json not found under %s; refusing" % CONFIG_DIR)
        except OSError:
            fail("shell.json at %s refused open (symlink or unreadable)" % CONFIG_PATH)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail("shell.json is not a regular file; refusing")
        if st.st_uid != os.geteuid():
            fail("shell.json is not owned by the current user; refusing")
        if st.st_nlink != 1:
            fail("shell.json has unexpected hard links; refusing")
        if st.st_size > MAX_CONFIG_BYTES:
            fail("shell.json exceeds the %d-byte limit; refusing" % MAX_CONFIG_BYTES)
        with os.fdopen(fd, "rb") as raw:
            blob = raw.read(MAX_CONFIG_BYTES + 1)
        fd = None
    finally:
        if fd is not None:
            os.close(fd)
        os.close(dirfd)
    if len(blob) > MAX_CONFIG_BYTES:
        fail("shell.json exceeds the %d-byte limit; refusing" % MAX_CONFIG_BYTES)
    try:
        return json.loads(blob.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("shell.json is not valid UTF-8 JSON; refusing")


def write_config(data) -> None:
    dirfd = open_config_dir()
    tmp_fd = None
    tmp_name = None
    try:
        for _ in range(100):
            candidate = ".shell.json.%s.tmp" % os.urandom(8).hex()
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
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        tmp_fd = None
        os.replace(tmp_name, CONFIG_NAME, src_dir_fd=dirfd, dst_dir_fd=dirfd)
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
        os.close(dirfd)


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        return
    changes = json.loads(sys.argv[1])
    changes.pop("id", None)

    data = read_existing_config()

    layout = data.get("bar", {}).get("layout", {})
    found = False

    def update(region: str) -> None:
        nonlocal found
        for entry in layout.get(region, []):
            if isinstance(entry, dict) and entry.get("id") == PLUGIN_ID:
                entry.update(changes)
                found = True

    for region in ("left", "center", "right"):
        update(region)

    if not found:
        print(f"{PLUGIN_ID} not found in bar layout", file=sys.stderr)
        sys.exit(1)

    write_config(data)
    print("ok")


if __name__ == "__main__":
    main()