# BackgroundFX

Background effects over the desktop wallpaper — painted by a GPU shader on a
full-screen background surface, so every window stays on top of it. Toggled
from the wand icon in the Omarchy bar.

Two effects:

- **Rain** — three depth layers of falling streaks with optional lightning bolts.
- **Fireplace** — a crackling hearth: breathing flame tongues, a glowing ember
  bed, rising sparks, and a warm light pool washing over the wallpaper.

## Install

```sh
omarchy plugin add https://github.com/davidjm/omarchy-rain.git --enable
```

The bar asks where to place the wand icon; `omarchy bar move davidjm.rain -s right`
moves it afterwards if you change your mind.

## Remove

```sh
omarchy plugin remove davidjm.rain
```

No files are written outside the plugin directory; removal leaves `shell.json`
and the wallpaper untouched.

## Usage

- Click the wand to toggle the current effect on/off.
- The icon turns accent-colored while an effect is active.
- When off, the effect surface is unmapped: nothing composites and nothing runs.
- A hash-free steady tick (~60 fps) drives a shader `time` uniform.

## Settings

**Right-click the wand for a settings menu** with an **effect switch** (Rain /
Fireplace), an **intensity / fire size slider**, a **pace slider** (rainfall
speed or flicker speed), and a **lightning** toggle (rain only). Sliders
preview live while you drag and commit on release — values are written as flat
keys on the widget's entry in `shell.json` (atomic rewrite), which the shell
hot-applies to the running widget, so no editor or restart is needed.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | enum | `Rain` | `Rain` (falling streaks) or `Fireplace` (crackling hearth) |
| `density` | number | `2` | 1–3: rain intensity (drizzle to downpour) or hearth size, continuous |
| `speed` | number | `1` | 0.5–3: rain fall velocity or fire flicker pace |
| `lightning` | boolean | `true` | Rain-only: random real bolts (with a soft sky flash behind them) |

Lightning draws an **actual bolt** — a seeded, jagged 8-segment path with a
side branch rendered in the shader, flickering on/off like a real strike before
fading. The fireplace fire is its own shader pass: five noise-breathed flame
tongues with curled edges, a dark log bed whose ember gaps simmer, points of
light drifting up as sparks, and a translucent warm glow so the wallpaper
shows through.

The menu is also the fastest way to read the current baked-in values; the same
fields can be hand-edited too (flat keys, like the stock widgets):

```json
{
  "id": "davidjm.rain",
  "mode": "Fireplace",
  "density": 2.4,
  "speed": 1.2,
  "lightning": true
}
```

## How it works

- The effect `PanelWindow` maps with `WlrLayer.Background`, the same layer the
  wallpaper uses (`namespace: "omarchy-background"`). Because it is created
  after the wallpaper, it composites above it but below all windows and the bar.
- `screen:` is bound to the bar window's monitor, so multi-bar setups get one
  effect surface per monitor with no duplication.
- The shader source lives in `rain.frag` / `rain.vert`, precompiled to
  `.qsb` (Qt 6 ShaderEffect requires the precompiled form) and driven by
  uniforms: `time`, `uRes`, `uIntensity`, `uSpeed`, `uFlash`, `uStrike`,
  `uStrikeSeed`, `uStrikePos`, `uMode`. `uMode` switches the pass: rain under
  0.5, fireplace above.
- Lightning is a QML sidecar: a drifting random timer picks a strike, freezes
  its shape (seed + screen position + length), then a five-step SequentialAnimation
  flickers `uStrike` 1 → 0 → 1 → 0 like a real bolt; the shader renders the
  jagged polyline and a soft sky glow, and a slow Behavior fade closes the flash.

## Notes

- Effects render behind windows, so fullscreen windows cover them entirely.
- The overlay is a plain transparent layer surface; it does not intercept
  input, so the desktop stays fully interactive.