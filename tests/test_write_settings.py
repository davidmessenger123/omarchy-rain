import copy
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import write_settings


class WriteSettingsTests(unittest.TestCase):
    def test_validates_finite_ranges_and_types(self):
        self.assertEqual(
            write_settings.validate_changes({"fps": 60, "quality": 0.5, "straightness": 0}),
            {"fps": 60, "quality": 0.5, "straightness": 0},
        )
        self.assertEqual(
            write_settings.validate_changes({
                "running": True,
                "effect": "Rain",
                "variant": "autumn",
                "corner": "tl",
                "straightness": 1,
                "density": 2,
                "speed": 1,
                "fps": 60,
                "quality": 1,
                "lightning": True,
                "audio": False,
                "instanceId": "instance-one-a",
            })["instanceId"],
            "instance-one-a",
        )
        for changes in (
            {"fps": float("nan")},
            {"fps": float("inf")},
            {"quality": -1},
            {"straightness": 2.1},
            {"fps": True},
            {"effect": "Unknown"},
            {"unknown": 1},
        ):
            with self.subTest(changes=changes), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    write_settings.validate_changes(changes)

    def test_selector_targets_one_instance(self):
        layout = {
            "left": [{"id": "other"}],
            "center": [{"id": "davidjm.rain", "density": 1}, {"id": "davidjm.rain", "density": 2}],
            "right": [],
        }
        selector = write_settings.parse_selector(json.dumps({"region": "center", "index": 1}))
        entry = write_settings.find_layout(layout, selector)
        entry["density"] = 2.5
        self.assertEqual(layout["center"][0]["density"], 1)
        self.assertEqual(layout["center"][1]["density"], 2.5)
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                write_settings.find_layout(layout, {})

    def test_instance_id_selects_duplicate_after_reorder(self):
        layout = {
            "left": [{"id": "davidjm.rain", "instanceId": "instance-one-a", "density": 1}],
            "center": [{"id": "davidjm.rain", "instanceId": "instance-two-b", "density": 2}],
            "right": [],
        }
        selector = write_settings.parse_selector(json.dumps({
            "region": "center",
            "index": 0,
            "entry": dict(layout["center"][0]),
            "instanceId": "instance-two-b",
        }))
        entry = write_settings.find_layout(layout, selector)
        entry["density"] = 2.5
        self.assertEqual(layout["center"][0]["density"], 2.5)
        self.assertEqual(layout["left"][0]["density"], 1)

    def test_selector_never_falls_back_to_another_duplicate(self):
        first = {"id": "davidjm.rain", "instanceId": "instance-one-a", "density": 1}
        second = {"id": "davidjm.rain", "instanceId": "instance-two-b", "density": 2}
        layout = {"left": [], "center": [first, second], "right": []}
        stale = write_settings.parse_selector(json.dumps({
            "region": "center",
            "index": 0,
            "entry": {"id": "davidjm.rain", "instanceId": "instance-one-a", "density": 1},
            "instanceId": "instance-two-b",
        }))
        self.assertIs(write_settings.find_layout(layout, stale), second)
        mismatched = write_settings.parse_selector(json.dumps({
            "region": "center",
            "index": 1,
            "entry": dict(second, density=99),
            "instanceId": "instance-two-b",
        }))
        self.assertIs(write_settings.find_layout(layout, mismatched), second)
        self.assertEqual(second["density"], 2)

    def test_duplicate_instance_ids_fail_closed(self):
        first = {"id": "davidjm.rain", "instanceId": "duplicate-id", "density": 1}
        second = {"id": "davidjm.rain", "instanceId": "duplicate-id", "density": 2}
        layout = {"left": [], "center": [first, second], "right": []}
        ambiguous = write_settings.parse_selector(json.dumps({
            "region": "center",
            "index": 1,
            "entry": dict(second),
            "instanceId": "duplicate-id",
        }))
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            write_settings.find_layout(layout, ambiguous)

    def test_qml_queue_is_bounded_coalesced_and_timed_out(self):
        source = (Path(__file__).resolve().parents[1] / "Rain.qml").read_text(encoding="utf-8")
        self.assertIn("readonly property int maxSettingsWrites: 8", source)
        self.assertIn("mergeSettingsOperations", source)
        self.assertIn("root.settingsWriteQueue = [pending]", source)
        self.assertNotIn("root.settingsWriteQueue.slice(0, root.maxSettingsWrites - 1)", source)
        self.assertIn("id: settingsWriteWatchdog", source)
        self.assertIn("root.timeoutSettingsWrite()", source)
        self.assertIn("property bool settingsProcessStopping: false", source)
        self.assertIn("root.settingsWriteQueue = [retry]", source)
        self.assertIn("operation.generation !== root.settingsWriteGeneration", source)
        self.assertIn("normalized.instanceId = root.ensureInstanceId()", source)
        self.assertIn("candidate.instanceId === instanceId", source)
        self.assertNotIn("index: 0, entry: entry", source)

    def test_qml_running_binding_is_not_replaced_by_toggle(self):
        source = (Path(__file__).resolve().parents[1] / "Rain.qml").read_text(encoding="utf-8")
        self.assertIn("property var runningOverride: undefined", source)
        self.assertIn("root.runningOverride === undefined", source)
        self.assertIn("root.runningOverride = !root.raining", source)
        self.assertIn("root.persistSettings({ \"running\": root.runningOverride })", source)
        self.assertNotIn("root. raining =", source)

    def test_qml_click_through_and_render_budget_are_bounded(self):
        source = (Path(__file__).resolve().parents[1] / "Rain.qml").read_text(encoding="utf-8")
        self.assertIn("WlrLayershell.keyboardFocus: WlrKeyboardFocus.None", source)
        self.assertIn("mask: Region {}", source)
        self.assertIn("readonly property int maxRenderPixels: 8294400", source)
        self.assertIn("readonly property int maxRenderDimension: 8192", source)
        self.assertIn("Math.sqrt(root.maxRenderPixels / (width * height))", source)
        self.assertIn("live: root.raining", source)

    def test_pending_shell_transaction_recovers_with_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            config_dir = Path(root)
            config = config_dir / "shell.json"
            old = {
                "version": 1,
                "bar": {"layout": {"right": [{"id": "davidjm.rain", "running": False}]}},
            }
            new = copy.deepcopy(old)
            new["bar"]["layout"]["right"][0]["running"] = True
            old_payload = (json.dumps(old, indent=2) + "\n").encode("utf-8")
            new_payload = (json.dumps(new, indent=2) + "\n").encode("utf-8")
            config.write_bytes(old_payload)
            config.chmod(0o640)
            journal = config_dir / write_settings.JOURNAL_NAME
            with mock.patch.object(write_settings, "CONFIG_DIR", str(config_dir)), \
                 mock.patch.object(write_settings, "CONFIG_PATH", str(config)), \
                 mock.patch.object(write_settings, "CONFIG_NAME", "shell.json"):
                dirfd = write_settings.open_config_dir()
                try:
                    write_settings.make_journal(
                        dirfd,
                        [(str(config), new_payload)],
                        str(journal),
                    )
                    write_settings.write_bytes(dirfd, "shell.json", new_payload, 0o640, write_settings.MAX_CONFIG_BYTES)
                    self.assertTrue(write_settings.recover_pending_transaction(dirfd))
                finally:
                    os.close(dirfd)
            self.assertEqual(config.read_bytes(), old_payload)
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o640)
            self.assertFalse(journal.exists())

    def test_concurrent_writes_preserve_every_instance(self):
        script = Path(__file__).resolve().parents[1] / "write_settings.py"
        with tempfile.TemporaryDirectory() as home:
            config_dir = Path(home) / ".config" / "omarchy"
            config_dir.mkdir(parents=True)
            count = 12
            config = {
                "version": 1,
                "bar": {
                    "layout": {
                        "left": [],
                        "center": [{"id": "davidjm.rain", "running": False} for _ in range(count)],
                        "right": [],
                    }
                },
            }
            (config_dir / "shell.json").write_text(json.dumps(config), encoding="utf-8")
            (config_dir / "shell.json").chmod(0o640)
            env = os.environ.copy()
            env["HOME"] = home
            processes = []
            for index in range(count):
                selector = json.dumps({"region": "center", "index": index})
                processes.append(subprocess.Popen(
                    [sys.executable, "-I", str(script), json.dumps({"running": index % 2 == 0}), selector],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=env,
                ))
            for process in processes:
                stdout, stderr = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, stderr or stdout)
                self.assertEqual(stdout.strip(), "ok")
            result = json.loads((config_dir / "shell.json").read_text(encoding="utf-8"))
            entries = result["bar"]["layout"]["center"]
            self.assertEqual([entry["running"] for entry in entries], [index % 2 == 0 for index in range(count)])
            self.assertEqual(stat.S_IMODE((config_dir / "shell.json").stat().st_mode), 0o640)
            self.assertEqual(stat.S_IMODE((config_dir / write_settings.LOCK_NAME).stat().st_mode), 0o600)
            self.assertFalse((config_dir / write_settings.JOURNAL_NAME).exists())


if __name__ == "__main__":
    unittest.main()
