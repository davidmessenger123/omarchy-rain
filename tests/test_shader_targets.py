import re
import struct
import unittest
import zlib
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent

SHADERS = ("rain.vert", "rain.frag", "upscale.frag")

# GLSL versions every supported RHI backend has to be able to find. Qt picks the
# closest match to the live context, so a backend with no baked counterpart logs
# "No GLSL shader code found" every frame and silently draws nothing.
REQUIRED_VERSIONS = ((b"440", b""), (b"320", b" es"))


def baked_sources(name):
    payload = zlib.decompress((PLUGIN_DIR / f"{name}.qsb").read_bytes()[4:])
    return set(re.findall(rb"#version (\d+)( es)?", payload))


class ShaderTargetTests(unittest.TestCase):
    def test_baked_shaders_cover_every_rhi_backend(self):
        for name in SHADERS:
            with self.subTest(shader=name):
                versions = baked_sources(name)
                for target in REQUIRED_VERSIONS:
                    self.assertIn(
                        target,
                        versions,
                        f"{name}.qsb has no GLSL #version {target[0].decode()}"
                        f"{target[1].decode()} entry, so Qt cannot build a "
                        f"pipeline for that backend. Re-run ./bake-shaders.sh.",
                    )

    def test_declared_payload_size_matches_header(self):
        for name in SHADERS:
            with self.subTest(shader=name):
                raw = (PLUGIN_DIR / f"{name}.qsb").read_bytes()
                self.assertEqual(struct.unpack(">I", raw[:4])[0], len(zlib.decompress(raw[4:])))


if __name__ == "__main__":
    unittest.main()
