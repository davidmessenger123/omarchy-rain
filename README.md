# BackgroundFX

Animated effects over the desktop wallpaper — drawn by a GPU shader on a
full-screen background surface, so every window stays on top of them. Toggled
from the wand icon in the Omarchy bar.

## Install

```sh
omarchy plugin add https://github.com/davidmessenger123/omarchy-rain.git --enable
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
- A framerate-tunable tick (15–60 fps, default 60) drives a shader `time`
  uniform; a single fragment shader paints every effect, rendered at a
  resolution scale you can set from 0.5x to 2x native.

## Effects

| Key | Effect |
| --- | --- |
| `Rain` | Falling streaks in three depth layers over a wet-window dim, with optional lightning bolts |
| `Snow` | Drifting, tumbling flakes in three depth layers with wind sway |
| `Ripples` | Rain landing on water: expanding puddle rings |
| `Dust` | Barely-moving motes drifting through a faint diagonal light shaft |
| `Fireflies` | Warm-green points of light wandering and blinking at dusk |
| `Leaves` | Autumn leaves tumbling down through warm golden light |
| `Aurora` | Undulating northern-lights curtains over a starry night sky |

## Settings

**Right-click the wand for a settings menu**: an effect switch, an
**intensity slider** (relabeled per effect, 1 = light to 3 = heavy), a
**speed slider**, a **framerate slider** (15–60 fps), a **resolution slider**
(0.5x–2x native, in 0.5x steps), a **lightning** toggle for the rain-based
effects, and an **audio reactive** toggle for the aurora (it swells and
shimmers with what you play). Sliders preview live while you drag and commit
on release — values are written as flat keys on the widget's entry in
`shell.json` (atomic rewrite), which the shell hot-applies to the running
widget, so no editor or restart is needed. Framerate and resolution apply to
**every** effect, not per effect.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `effect` | string | `"Rain"` | `Rain`, `Snow`, `Ripples`, `Dust`, `Fireflies`, `Leaves`, `Aurora` |
| `density` | number | `2` | 1 (light) to 3 (heavy); per-effect meaning |
| `speed` | number | `1` | 0.5 (lazy) to 3 (fast) effect motion |
| `fps` | number | `60` | Animation framerate, 15–60 (lower = less GPU, choppier) |
| `quality` | number | `1` | Render scale vs native: 0.5 / 1 / 1.5 / 2 (2x = supersampled) |
| `lightning` | boolean | `true` | Random real bolts for `Rain` |
| `audio` | boolean | `false` | `Aurora` reacts to system audio |

The menu is also the fastest way to read the current baked-in values; the same
fields can be hand-edited too (flat keys, like the stock widgets):

```json
{
  "id": "davidjm.rain",
  "effect": "Rain",
  "density": 2.4,
  "speed": 1.2,
  "fps": 60,
  "quality": 1,
  "lightning": true,
  "audio": true
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
  (effect switch 0–6), plus `uFlash`, `uStrike`, `uStrikeSeed`, `uStrikePos`
  for lightning.
- The effect is painted into an offscreen canvas whose size is `quality` × the
  monitor's resolution, captured with `ShaderEffectSource` (`live`) and
  stretched over the full screen by a second, trivial sampling pass
  (`upscale.frag`). At 0.5x that is a quarter of the pixels per frame; at 2x
  the effect is supersampled and downscaled. `time` still advances by real
  seconds per tick, so lowering `fps` slows the *frame rate*, not the motion.
- Lightning is a QML sidecar: a drifting random timer picks a strike, freezes
  its shape (seed + screen position + length), then a five-step SequentialAnimation
  flickers `uStrike` 1 → 0 → 1 → 0 like a real bolt; the shader renders the
  jagged polyline and a soft sky glow, and a slow Behavior fade closes the flash.

## Notes

- Effects render behind windows, so fullscreen windows cover them entirely.
- The overlay is a plain transparent layer surface; it does not intercept
  input, so the desktop stays fully interactive.