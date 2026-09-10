# BackgroundFX

Animated effects over the desktop wallpaper — drawn by a GPU shader on a
full-screen background surface, so every window stays on top of them. Toggled
from the wand icon in the Omarchy bar.

## Install

```sh
omarchy plugin add https://github.com/davidjm/omarchy-rain.git --enable
```

The bar asks where to place the wand; `omarchy bar move davidjm.rain -s right`
moves it afterwards if you change your mind.

## Remove

```sh
omarchy plugin remove davidjm.rain
```

No files are written outside the plugin directory; removal leaves `shell.json`
and the wallpaper untouched.

- Click the wand to toggle the effect on/off.
- The icon turns accent-colored while the effect is active.
- When off, the effect surface is unmapped: nothing composites and nothing runs.
- A hash-free steady tick (~60 fps) drives a shader `time` uniform; a single
  fragment shader paints every effect.

## Effects

| Key | Effect |
| --- | --- |
| `Rain` | Falling streaks in three depth layers over a wet-window dim, with optional lightning bolts |
| `Snow` | Drifting, tumbling flakes in three depth layers with wind sway |
| `Ripples` | *(coming)* rain with expanding puddle rings |
| `Dust` | *(coming)* slow floating dust motes |
| `Fireflies` | *(coming)* tiny wandering points of light |
| `Meteors` | *(coming)* shooting-star streaks across the sky |
| `Leaves` | *(coming)* leaves spiraling down |
| `Aurora` | *(coming)* undulating northern-lights ribbons |

## Settings

**Right-click the wand for a settings menu**: an effect switch, an
**intensity slider** (relabeled per effect, 1 = light to 3 = heavy), a
**speed slider**, and a **lightning** toggle for the rain-based effects.
Sliders preview live while you drag and commit on release — values are written
as flat keys on the widget's entry in `shell.json` (atomic rewrite), which the
shell hot-applies to the running widget, so no editor or restart is needed.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `effect` | string | `"Rain"` | `Rain`, `Snow`, `Ripples`, `Dust`, `Fireflies`, `Meteors`, `Leaves`, `Aurora` |
| `density` | number | `2` | 1 (light) to 3 (heavy); per-effect meaning |
| `speed` | number | `1` | 0.5 (lazy) to 3 (fast) effect motion |
| `lightning` | boolean | `true` | Random real bolts for `Rain` / `Ripples` |

The menu is also the fastest way to read the current baked-in values; the same
fields can be hand-edited too (flat keys, like the stock widgets):

```json
{
  "id": "davidjm.rain",
  "effect": "Rain",
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
  uniforms: `time`, `uRes`, `uIntensity` (raw 1–3), `uSpeed`, `uEffect`
  (effect switch 0–7), plus `uFlash`, `uStrike`, `uStrikeSeed`, `uStrikePos`
  for lightning.
- Lightning is a QML sidecar: a drifting random timer picks a strike, freezes
  its shape (seed + screen position + length), then a five-step SequentialAnimation
  flickers `uStrike` 1 → 0 → 1 → 0 like a real bolt; the shader renders the
  jagged polyline and a soft sky glow, and a slow Behavior fade closes the flash.

## Notes

- Effects render behind windows, so fullscreen windows cover them entirely.
- The overlay is a plain transparent layer surface; it does not intercept
  input, so the desktop stays fully interactive.