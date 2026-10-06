#!/usr/bin/env bash
# Re-bake the ShaderEffect .qsb files from their GLSL sources.
#
# A baked shader only carries the GLSL versions listed here at bake time, and Qt
# picks the closest match to whatever its RHI backend supports at runtime. Bake
# for too few targets and the effect still maps its layer surface, but every
# frame fails with "No GLSL shader code found" / "Failed to build graphics
# pipeline state" and nothing is ever drawn.
#
#   440     Vulkan and desktop GL 4.4
#   320 es  GL ES 3.x - what NVIDIA's EGL hands Qt on Wayland
set -euo pipefail

QSB="${QSB:-/usr/lib/qt6/bin/qsb}"
if [ ! -x "$QSB" ]; then
  QSB="$(command -v qsb)"
fi

TARGETS="440,320 es"

cd "$(dirname "$0")"
for source in rain.vert rain.frag upscale.frag; do
  "$QSB" --glsl "$TARGETS" "$source" -o "$source.qsb"
done
