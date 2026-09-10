# Rain

Animated rain over the desktop wallpaper — drawn by a GPU shader on a
full-screen background surface, so every window stays on top of it. Toggled
from the droplet icon in the Omarchy bar.

## Install

```sh
omarchy plugin add https://github.com/davidjm/omarchy-rain.git --enable
```

The bar asks where to place the droplet; `omarchy bar move davidjm.rain -s right`
moves it afterwards if you change your mind.

## Remove

```sh
omarchy plugin remove davidjm.rain
```

No files are written outside the plugin directory; removal leaves `shell.json`
and the wallpaper untouched.

- Click the droplet to toggle rain on/off.
- The icon turns accent-colored while rain is active.
- When off, the rain surface is unmapped: nothing composites and nothing runs.
- A hash-free steady tick (~60 fps) drives a shader `time` uniform; the
  fragment shader paints three depth layers of falling streaks plus a wet-window
  dim.

## Settings

**Right-click the droplet for a settings menu** with an **intensity slider**
(continuous, from drizzle to downpour), a **rainfall speed slider**, and a
**lightning** toggle. Sliders preview live while you drag and commit on
release — values are written as flat keys on the widget's entry in
`shell.json` (atomic rewrite), which the shell hot-applies to the running
widget, so no editor or restart is needed.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `density` | number | `2` | 1 (drizzle) to 3 (downpour), continuous |
| `speed` | number | `1` | 0.5 (lazy) to 3 (torrential) fall velocity |
| `lightning` | boolean | `true` | Random real bolts (with a soft sky flash behind them) |

Lightning now draws an **actual bolt** — a seeded, jagged 8-segment path with a
side branch rendered in the shader, flickering on/off like a real strike before
fading. It also depends on `lightning` being on and `raining` being active.

The menu is also the fastest way to read the current baked-in values; the same
fields can be hand-edited too (flat keys, like the stock widgets):

```json
{
  "id": "davidjm.rain",
  "density": 2.4,
  "speed": 1.2,
  "lightning": true
}
```

## How it works

- The rain `PanelWindow` maps with `WlrLayer.Background`, the same layer the
  wallpaper uses (`namespace: "omarchy-background"`). Because it is created
  after the wallpaper, it composites above it but below all windows and the bar.
- `screen:` is bound to the bar window's monitor, so multi-bar setups get one
  rain surface per monitor with no duplication.
- The shader source lives in `rain.frag` / `rain.vert`, precompiled to
  `.qsb` (Qt 6 ShaderEffect requires the precompiled form) and driven by
  uniforms: `time`, `uRes`, `uIntensity`, `uSpeed`, `uFlash`, `uStrike`,
  `uStrikeSeed`, `uStrikePos`.
- Lightning is a QML sidecar: a drifting random timer picks a strike, freezes
  its shape (seed + screen position + length), then a five-step SequentialAnimation
  flickers `uStrike` 1 → 0 → 1 → 0 like a real bolt; the shader renders the
  jagged polyline and a soft sky glow, and a slow Behavior fade closes the flash.

## Notes

- Rain renders behind windows, so fullscreen windows cover it entirely.
- The overlay is a plain transparent layer surface; it does not intercept
  input, so the desktop stays fully interactive.