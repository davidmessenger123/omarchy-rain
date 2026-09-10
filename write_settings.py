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
"""

import json
import os
import sys

PLUGIN_ID = "davidjm.rain"
CONFIG_PATH = os.path.expanduser("~/.config/omarchy/shell.json")


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        return
    changes = json.loads(sys.argv[1])
    changes.pop("id", None)

    with open(CONFIG_PATH, encoding="utf-8") as f:
        data = json.load(f)

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

    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, CONFIG_PATH)
    print("ok")


if __name__ == "__main__":
    main()