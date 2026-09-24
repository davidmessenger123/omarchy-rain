import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import Quickshell.Io
import Quickshell.Services.Pipewire
import qs.Commons
import qs.Ui

// BackgroundFX — animated desktop effects. A full-screen layer-shell surface
// mapped on the same `Background` layer Omarchy's wallpaper uses, so the chosen
// effect plays over the desktop while every window (and the bar) stays
// composited on top. A GPU fragment shader paints it, so once running it costs
// almost no CPU.
BarWidget {
  id: root

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Settings live in the widget's inline shell.json entry (flat keys) and are
  // normally injected into this widget's `settings` when the shell hot-applies
  // an edit. At mount, though, the bar provides the real entry through
  // bar.layoutConfig before the injected `settings` arrives, so read each
  // value preferring injected settings and falling back to this widget's own
  // entry, with the defaults as a last resort. Rebinding on `settings` (via
  // setting()) plus `bar` (via selfEntry()) keeps the values live.
  property real density: root.boundedNumber(root.effective("density", 2), 2, 1, 3)
  property real speed: root.boundedNumber(root.effective("speed", 1.0), 1.0, 0.5, 3)
  property bool lightning: root.effective("lightning", true) === true
  property bool audio: root.effective("audio", false) === true
  property string effect: root.validEffect(root.effective("effect", "Rain"))
  // Sub-variant for the Falling Leaves effect (see the variantKeys catalogue).
  property string variant: String(root.effective("variant", "autumn")) || "autumn"
  // Light-source corner for the Light Shafts effect (see cornerKeys).
  property string corner: String(root.effective("corner", "tl")) || "tl"
  // Ray straightness for Light Shafts: 0 = wavy, 1 = subtle, 2 = straight.
  property real straightness: root.boundedNumber(root.effective("straightness", 1.0), 1.0, 0, 2)
  // Render quality knobs, applied globally to every effect. fps caps the
  // animation's frame rate; quality scales the resolution the shader paints
  // at (0.5x = a quarter of the pixels, 2x = supersampled).
  property real fps: root.boundedNumber(root.effective("fps", 60), 60, 15, 60)
  property real quality: root.boundedNumber(root.effective("quality", 1), 1, 0.5, 2)
  readonly property int maxRenderPixels: 8294400
  readonly property int maxRenderDimension: 8192
  readonly property var safeProcessEnvironment: ({
    "PATH": "/usr/bin:/bin",
    "HOME": Quickshell.env("HOME"),
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8"
  })

  // Effect catalogue. `effectIds` maps every catalogue key to the shader's
  // uEffect switch; `implementedEffects` lists the ones that actually render
  // and grows as effects ship, so the menu only offers built effects.
  readonly property var effectKeys: ["Rain", "Snow", "Ripples", "Dust", "Fireflies", "Leaves", "Aurora", "Embers", "Bubbles", "Confetti", "Caustics", "Light Shafts"]
  readonly property var effectLabels: {
    "Rain": "Rain", "Snow": "Snowfall", "Ripples": "Puddle Ripples",
    "Dust": "Dust Motes", "Fireflies": "Fireflies",
    "Leaves": "Falling Leaves", "Aurora": "Aurora",
    "Embers": "Embers",
    "Bubbles": "Bubbles", "Confetti": "Confetti", "Caustics": "Caustic Light",
    "Light Shafts": "Light Shafts"
  }
  readonly property var effectIds: {
    "Rain": 0, "Snow": 1, "Ripples": 2, "Dust": 3,
    "Fireflies": 4, "Leaves": 5, "Aurora": 6,
    "Embers": 9, "Bubbles": 10,
    "Confetti": 11, "Caustics": 12, "Light Shafts": 13
  }
  readonly property var settingsTitles: {
    "Rain": "RAIN SETTINGS", "Snow": "SNOWFALL SETTINGS", "Ripples": "PUDDLE RIPPLE SETTINGS",
    "Dust": "DUST MOTES SETTINGS", "Fireflies": "FIREFLY SETTINGS",
    "Leaves": "FALLING LEAVES SETTINGS", "Aurora": "AURORA SETTINGS",
    "Embers": "EMBER SETTINGS",
    "Bubbles": "BUBBLE SETTINGS", "Confetti": "CONFETTI SETTINGS", "Caustics": "CAUSTIC SETTINGS",
    "Light Shafts": "LIGHT SHAFT SETTINGS"
  }
  readonly property var intensityLabels: {
    "Rain": "INTENSITY", "Snow": "DENSITY", "Ripples": "RAIN INTENSITY",
    "Dust": "AMOUNT", "Fireflies": "AMOUNT",
    "Leaves": "DENSITY", "Aurora": "BRIGHTNESS",
    "Embers": "AMOUNT",
    "Bubbles": "AMOUNT", "Confetti": "DENSITY", "Caustics": "BRIGHTNESS",
    "Light Shafts": "BRIGHTNESS"
  }
  readonly property var speedLabels: {
    "Rain": "RAINFALL SPEED", "Snow": "SNOWFALL SPEED", "Ripples": "RAIN SPEED",
    "Dust": "FLOAT SPEED", "Fireflies": "DRIFT SPEED",
    "Leaves": "FALL SPEED", "Aurora": "MOTION SPEED",
    "Embers": "EMBER RISE SPEED",
    "Bubbles": "BUBBLE RISE SPEED", "Confetti": "CONFETTI FALL SPEED", "Caustics": "CAUSTIC MOTION SPEED",
    "Light Shafts": "LIGHT SHAFT MOTION"
  }
  readonly property var rainyEffects: ["Rain"]
  readonly property var implementedEffects: [
    "Rain", "Snow", "Ripples", "Dust", "Fireflies", "Leaves", "Aurora", "Embers", "Bubbles", "Confetti", "Caustics", "Light Shafts"
  ]

  // Leaf style variants for the Falling Leaves effect. `variantKeys` maps each
  // catalogue key to the shader's uVariant switch; the menu only offers these.
  readonly property var variantKeys: ["autumn", "cherry"]
  readonly property var variantLabels: {
    "autumn": "Autumn Leaves", "cherry": "Cherry Blossom"
  }

  // Light-source corners for the Light Shafts effect. `cornerKeys` maps each
  // choice to the shader's uCorner switch; the menu only offers these.
  readonly property var cornerKeys: ["tl", "tr", "bl", "br"]
  readonly property var cornerLabels: {
    "tl": "Top-left", "tr": "Top-right", "bl": "Bottom-left", "br": "Bottom-right"
  }

  // While a settings slider is being dragged, the preview values drive the
  // shader immediately; they clear when the persisted settings come back
  // through the shell's live patch (see persistSettings -> onSettingsChanged).
  property real densityPreview: -1
  property real speedPreview: -1
  property real fpsPreview: -1
  property real qualityPreview: -1
  property real straightnessPreview: -1

  // Active lightning strike: amount (0..1, animated with a flicker), the
  // per-strike seed/position/length that fix the bolt's shape for its short
  // flash, and the sky-behind-it glow.
  property real strike: 0.0
  property real strikeSeed: 0.0
  property real strikeX: 0.5
  property real strikeLen: 0.6

  property bool settingsOpen: false
  property var runningOverride: undefined
  property bool raining: root.runningOverride === undefined
    ? root.effective("running", false) === true
    : root.runningOverride
  property string instanceId: root.validInstanceId(root.effective("instanceId", ""))
  property real elapsed: 0.0
  property real flash: 0.0
  property real audioLevel: 0.0
  property string keyNotice: ""
  property var settingsWriteQueue: []
  property var activeSettingsWrite: null
  property bool settingsProcessStopping: false
  property int settingsWriteGeneration: 0
  property string lastSettingsDiagnostic: ""
  readonly property int maxSettingsWrites: 8
  readonly property bool audioReactive: root.raining && root.audio && root.effect === "Aurora"
  readonly property var renderDimensions: root.effectRenderSize()

  // Absolute path to this plugin's folder, resolved from the QML file itself so
  // settings persistence finds its neighbor write_settings.py wherever the
  // plugin lives.
  readonly property string pluginDir: {
    var path = String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")
    return path.charAt(path.length - 1) === "/" ? path : path + "/"
  }

  // This widget's live entry from the shell's layout config — the authoritative
  // copy of its parameters the bar is currently running with.
  function boundedNumber(value, fallback, minimum, maximum) {
    var number = Number(value)
    if (!isFinite(number)) return fallback
    return Math.max(minimum, Math.min(maximum, number))
  }

  function validEffect(value) {
    var name = String(value || "Rain")
    return root.implementedEffects.indexOf(name) >= 0 ? name : "Rain"
  }

  function validInstanceId(value) {
    var text = String(value || "")
    return /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(text) ? text : ""
  }

  function ensureInstanceId() {
    var existing = root.validInstanceId(root.instanceId)
    if (existing) {
      if (root.instanceId !== existing) root.instanceId = existing
      return existing
    }
    var seed = String(root.moduleName || "rain").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 48) || "rain"
    var generated = seed + "-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 0x100000000).toString(36)
    root.instanceId = generated
    return generated
  }

  function hostEntry(item) {
    return item && "entry" in item && "region" in item && item["entry"] &&
      (item["entry"].id || "") === "davidjm.rain" ? item["entry"] : null
  }

  function ownEntry() {
    var item = root.parent
    while (item) {
      var entry = root.hostEntry(item)
      if (entry) return entry
      item = item.parent
    }
    return root.selfEntry()
  }

  function selfEntry() {
    var lc = root.bar ? root.bar.layoutConfig : null
    if (!lc) return null
    var found = null
    for (var r = 0; r < 3; r++) {
      var region = ["left", "center", "right"][r]
      var list = lc[region]
      if (!list) continue
      for (var i = 0; i < list.length; i++) {
        if (list[i] && (list[i].id || "") === "davidjm.rain") {
          if (found) return null
          found = list[i]
        }
      }
    }
    return found
  }

  function effective(name, fallback) {
    var v = root.setting(name, undefined)
    if (v !== undefined && v !== null) return v
    var entry = root.ownEntry()
    var e = entry ? entry[name] : undefined
    return (e === undefined || e === null) ? fallback : e
  }

  function entrySelector() {
    var instanceId = root.ensureInstanceId()
    var layout = root.bar ? root.bar.layoutConfig : null
    if (layout) {
      var instanceMatches = []
      for (var regionIndex = 0; regionIndex < 3; regionIndex++) {
        var regionName = ["left", "center", "right"][regionIndex]
        var regionEntries = layout[regionName]
        if (!Array.isArray(regionEntries)) continue
        for (var entryIndex = 0; entryIndex < regionEntries.length; entryIndex++) {
          var candidate = regionEntries[entryIndex]
          if (candidate && (candidate.id || "") === "davidjm.rain" && candidate.instanceId === instanceId) {
            instanceMatches.push({ region: regionName, index: entryIndex, entry: candidate, instanceId: instanceId })
          }
        }
      }
      if (instanceMatches.length === 1) return instanceMatches[0]
      if (instanceMatches.length > 1) return {}
    }
    var item = root.parent
    while (item) {
      var entry = root.hostEntry(item)
      if (entry) {
        var existingId = root.validInstanceId(entry.instanceId)
        if (existingId) {
          root.instanceId = existingId
          instanceId = existingId
        }
        var region = item["region"]
        var entries = layout && layout[region]
        if (Array.isArray(entries)) {
          var selectedIndex = -1
          if (typeof item.index === "number" && item.index >= 0 && item.index < entries.length) {
            if (JSON.stringify(entries[item.index]) === JSON.stringify(entry)) selectedIndex = item.index
          }
          if (selectedIndex < 0) {
            var matchingIndexes = []
            for (var i = 0; i < entries.length; i++) {
              if (JSON.stringify(entries[i]) === JSON.stringify(entry)) matchingIndexes.push(i)
            }
            if (matchingIndexes.length === 1) selectedIndex = matchingIndexes[0]
          }
          if (selectedIndex >= 0) {
            return { region: region, index: selectedIndex, entry: entry, instanceId: instanceId }
          }
        }
      }
      item = item.parent
    }
    var single = root.selfEntry()
    if (single) {
      for (var fallbackRegionIndex = 0; fallbackRegionIndex < 3; fallbackRegionIndex++) {
        var fallbackRegion = ["left", "center", "right"][fallbackRegionIndex]
        var fallbackEntries = layout ? layout[fallbackRegion] : null
        if (!Array.isArray(fallbackEntries)) continue
        for (var fallbackIndex = 0; fallbackIndex < fallbackEntries.length; fallbackIndex++) {
          if (fallbackEntries[fallbackIndex] === single || JSON.stringify(fallbackEntries[fallbackIndex]) === JSON.stringify(single)) {
            return { region: fallbackRegion, index: fallbackIndex, entry: single, instanceId: instanceId }
          }
        }
      }
    }
    return {}
  }

  function effectRenderSize() {
    var windowWidth = Number(rainWindow.width)
    var windowHeight = Number(rainWindow.height)
    if (!isFinite(windowWidth) || windowWidth <= 0) windowWidth = 2
    if (!isFinite(windowHeight) || windowHeight <= 0) windowHeight = 2
    var scale = root.currentQuality()
    var width = Math.max(2, Math.min(root.maxRenderDimension, Math.round(windowWidth * scale)))
    var height = Math.max(2, Math.min(root.maxRenderDimension, Math.round(windowHeight * scale)))
    if (width * height > root.maxRenderPixels) {
      var budgetScale = Math.sqrt(root.maxRenderPixels / (width * height))
      width = Math.max(2, Math.min(root.maxRenderDimension, Math.floor(width * budgetScale)))
      height = Math.max(2, Math.min(root.maxRenderDimension, Math.floor(height * budgetScale)))
    }
    return { width: width, height: height }
  }

  // Live value while a slider drags, persisted value once the shell patches it
  // back through onSettingsChanged (which clears the preview).
  function currentFps() {
    return root.boundedNumber(root.fpsPreview >= 0 ? root.fpsPreview : root.fps, 60, 15, 60)
  }
  function currentQuality() {
    return root.boundedNumber(root.qualityPreview >= 0 ? root.qualityPreview : root.quality, 1, 0.5, 2)
  }
  function currentStraightness() {
    return root.boundedNumber(root.straightnessPreview >= 0 ? root.straightnessPreview : root.straightness, 1, 0, 2)
  }

  function toggle() {
    root.runningOverride = !root.raining
    root.persistSettings({ "running": root.runningOverride })
  }

  function toggleSettings() {
    root.settingsOpen = !root.settingsOpen
    if (root.settingsOpen) {
      root.keyNotice = ""
      root.densityPreview = -1
      root.speedPreview = -1
      root.fpsPreview = -1
      root.qualityPreview = -1
      root.straightnessPreview = -1
    }
  }

  function closeSettings() {
    root.settingsOpen = false
  }

  // The KeyboardPanel routes outside-click dismissal and bar popout handoff
  // through `owner`; both funnel here.
  function close() {
    root.closeSettings()
  }
  function closeForPopoutSwitch() {
    root.closeSettings()
  }

  // Harmonize this widget's copy whenever the shell live-patches settings, so
  // a released slider stops previewing and the bound (now-current) value takes
  // over with no visible jump.
  onSettingsChanged: {
    if (root.runningOverride === undefined || root.effective("running", false) === root.runningOverride) {
      root.runningOverride = undefined
    }
    root.densityPreview = -1
    root.speedPreview = -1
    root.fpsPreview = -1
    root.qualityPreview = -1
    root.straightnessPreview = -1
  }

  function setDensity(value) {
    var number = root.boundedNumber(value, 2, 1, 3)
    root.persistSettings({ "density": number }, "Saved — intensity " + number.toFixed(1) + ".")
  }

  function setSpeed(value) {
    var number = root.boundedNumber(value, 1, 0.5, 3)
    root.persistSettings({ "speed": number }, "Saved — speed " + number.toFixed(2) + ".")
  }

  function setFps(value) {
    var number = root.boundedNumber(value, 60, 15, 60)
    root.persistSettings({ "fps": Math.round(number) }, "Saved — framerate " + Math.round(number) + " fps.")
  }

  function setQuality(value) {
    var number = root.boundedNumber(value, 1, 0.5, 2)
    root.persistSettings({ "quality": number }, "Saved — resolution " + number.toFixed(1) + "x.")
  }

  function setLightning(on) {
    root.persistSettings({ "lightning": on === true }, on ? "Saved — lightning on." : "Saved — lightning off.")
  }

  function setAudio(on) {
    root.persistSettings({ "audio": on === true }, on ? "Saved — audio response on." : "Saved — audio response off.")
  }

  function setEffect(e) {
    var effect = root.validEffect(e)
    root.persistSettings({ "effect": effect }, "Saved — effect " + root.effectLabels[effect] + ".")
  }

  function setVariant(v) {
    var variant = v === "cherry" ? "cherry" : "autumn"
    root.persistSettings({ "variant": variant }, "Saved — style " + root.variantLabels[variant] + ".")
  }

  function setCorner(k) {
    var corner = ["tl", "tr", "bl", "br"].indexOf(k) >= 0 ? k : "tl"
    root.persistSettings({ "corner": corner }, "Saved — light from " + root.cornerLabels[corner] + ".")
  }

  function setStraightness(value) {
    var number = root.boundedNumber(value, 1, 0, 2)
    root.persistSettings({ "straightness": number }, "Saved — straightness " + number.toFixed(1) + ".")
  }

  function fireStrike() {
    root.strikeX = 0.15 + 0.7 * Math.random()
    root.strikeLen = 0.30 + 0.5 * Math.random()
    root.strikeSeed = Math.floor(Math.random() * 100000)
    root.strike = 0.0
    root.flash = 0.45
    flashFall.restart()
    strikeAnim.start()
  }

  function mergeSettingsOperations(previous, next) {
    var merged = { changes: {}, successNotice: String(next.successNotice || "") }
    var keys = ["changes"]
    for (var operationIndex = 0; operationIndex < keys.length; operationIndex++) {
      var source = previous[keys[operationIndex]]
      for (var key in source) merged.changes[key] = source[key]
    }
    for (var nextKey in next.changes) merged.changes[nextKey] = next.changes[nextKey]
    return merged
  }

  function persistSettings(changes, successNotice) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return
    var normalized = {}
    for (var key in changes) normalized[key] = changes[key]
    normalized.instanceId = root.ensureInstanceId()
    var operation = { changes: normalized, successNotice: String(successNotice || "") }
    var pending = null
    for (var queueIndex = 0; queueIndex < root.settingsWriteQueue.length && queueIndex < root.maxSettingsWrites; queueIndex++) {
      pending = pending === null
        ? root.settingsWriteQueue[queueIndex]
        : root.mergeSettingsOperations(pending, root.settingsWriteQueue[queueIndex])
    }
    if (pending !== null) pending = root.mergeSettingsOperations(pending, operation)
    else pending = operation
    root.settingsWriteQueue = [pending]
    root.keyNotice = "Saving…"
    root.startSettingsWrite()
  }

  function startSettingsWrite() {
    if (root.settingsProcessStopping || configWriteProcess.running || root.activeSettingsWrite !== null || root.settingsWriteQueue.length === 0) return
    var operation = root.settingsWriteQueue[0]
    root.settingsWriteQueue = root.settingsWriteQueue.slice(1)
    root.settingsWriteGeneration++
    operation.generation = root.settingsWriteGeneration
    root.activeSettingsWrite = operation
    root.lastSettingsDiagnostic = ""
    configWriteProcess.command = [
      "/usr/bin/python3",
      "-I",
      root.pluginDir + "write_settings.py",
      JSON.stringify(operation.changes),
      JSON.stringify(root.entrySelector())
    ]
    settingsWriteWatchdog.interval = 5000
    settingsWriteWatchdog.restart()
    configWriteProcess.running = true
  }

  function timeoutSettingsWrite() {
    if (!configWriteProcess.running || root.activeSettingsWrite === null) return
    var operation = root.activeSettingsWrite
    root.lastSettingsDiagnostic = "settings write timed out"
    root.keyNotice = "Save timed out; retrying with newer settings."
    root.settingsProcessStopping = true
    root.activeSettingsWrite = null
    root.settingsWriteGeneration++
    configWriteProcess.running = false
    var retry = { changes: {}, successNotice: operation.successNotice }
    for (var key in operation.changes) retry.changes[key] = operation.changes[key]
    if (root.settingsWriteQueue.length > 0) retry = root.mergeSettingsOperations(retry, root.settingsWriteQueue[0])
    root.settingsWriteQueue = [retry]
    console.warn("omarchy-rain settings: timeout for generation " + operation.generation)
  }

  // Drives the shader's `time` uniform while the rain is visible. The interval
  // follows the `fps` setting (15-60), and `elapsed` advances by the *actual*
  // per-tick seconds so a lower framerate slows the effect down, not the
  // motion. Keeping the surface hidden when off means the compositor never
  // composites it.
  Timer {
    id: ticker
    interval: Math.max(1, Math.round(1000 / root.currentFps()))
    repeat: true
    running: root.raining
    onTriggered: root.elapsed = root.elapsed + ticker.interval / 1000.0
  }

  // Random lightning. Sometimes a distant storm front just flashes the sky,
  // sometimes it fires an actual bolt (see fireStrike and the shader's
  // lighting). The interval drifts so strikes never feel metronomic.
  Timer {
    id: stormClock
    interval: 3400
    repeat: true
    running: root.raining && root.rainyEffects.indexOf(root.effect) >= 0 && root.lightning
    onTriggered: {
      interval = 2600 + Math.random() * 4200
      if (Math.random() < 0.55) root.fireStrike()
      else {
        root.flash = 0.18
        flashFall.restart()
      }
    }
  }

  // A strike is a short, jerky on/off flicker like real lightning, then it's
  // gone. The bolt's shape (seed, position, length) was set before this starts
  // and stays put for the whole flash.
  SequentialAnimation {
    id: strikeAnim
    running: false
    NumberAnimation { target: root; property: "strike"; to: 1.0; duration: 36 }
    NumberAnimation { target: root; property: "strike"; to: 0.08; duration: 42 }
    NumberAnimation { target: root; property: "strike"; to: 0.85; duration: 30 }
    NumberAnimation { target: root; property: "strike"; to: 0.05; duration: 120 }
    NumberAnimation { target: root; property: "strike"; to: 0.0; duration: 140 }
  }

  Timer {
    id: flashFall
    interval: 380
    onTriggered: root.flash = 0.0
  }

  Timer {
    id: audioTicker
    interval: 33
    repeat: true
    running: root.audioReactive
    onTriggered: {
      var peak = Number(audioPeak.peak)
      var target = isFinite(peak) && peak > 0 ? Math.min(1, peak * 3) : 0
      var coefficient = target > root.audioLevel ? 0.45 : 0.12
      root.audioLevel = root.audioLevel + (target - root.audioLevel) * coefficient
    }
  }

  onAudioReactiveChanged: {
    if (!root.audioReactive) root.audioLevel = 0
  }

  // System audio monitoring for audio-reactive effects (Aurora). Reads the
  // default sink's per-frame peak; the ticker smooths it into `audioLevel`
  // with a fast attack and slow release so the aurora swells with the music.
  PwNodePeakMonitor {
    id: audioPeak
    node: Pipewire.defaultAudioSink
    enabled: root.audioReactive
  }

  Behavior on flash {
    enabled: root.raining
    NumberAnimation { duration: 340; easing.type: Easing.OutCubic }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf0d0"
    tooltipText: "BackgroundFX — animated effects over the wallpaper"
    horizontalMargin: 8.25
    verticalPadding: 7.5
    active: root.raining

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) root.toggleSettings()
      else root.toggle()
    }
  }

  // Right-click settings menu — the effect switch plus continuous intensity and
  // speed sliders (per-effect labels) and lightning for the rainy effects.
  // Changes apply live while dragging and persist to shell.json on release
  // (live-patched by the shell, so no restart needed).
  KeyboardPanel {
    id: settingsPanel
    anchorItem: button
    bar: root.bar
    owner: root
    open: root.settingsOpen
    focusTarget: densitySlider
    contentWidth: settingsPanel.fittedContentWidth(Style.space(320))
    contentHeight: settingsPanel.fittedContentHeight(form.implicitHeight)

    PanelKeyCatcher {
      id: panelKeys
      anchors.fill: parent
      blocked: effectDropdown.popupOpen
      onCloseRequested: root.closeSettings()
      onActivateRequested: {
        if (lightningToggle.activeFocus) root.setLightning(!root.lightning)
        else if (audioToggle.activeFocus) root.setAudio(!root.audio)
      }
      onReturnRequested: {
        if (lightningToggle.activeFocus) root.setLightning(!root.lightning)
        else if (audioToggle.activeFocus) root.setAudio(!root.audio)
      }

      ColumnLayout {
        id: form
        anchors.fill: parent
        spacing: Style.space(8)

        Text {
          text: root.settingsTitles[root.effect] || "BACKGROUNDFX SETTINGS"
          color: Color.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          font.bold: true
          font.letterSpacing: 2
        }

        Dropdown {
          id: effectDropdown
          label: "EFFECT"
          options: {
            var o = []
            for (var i = 0; i < root.implementedEffects.length; i++) {
              var k = root.implementedEffects[i]
              o.push({ "value": k, "label": root.effectLabels[k] })
            }
            return o
          }
          value: root.effect
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          onChanged: root.setEffect(value)
        }

        Dropdown {
          id: variantDropdown
          label: "STYLE"
          visible: root.effect === "Leaves"
          options: {
            var o = []
            for (var i = 0; i < root.variantKeys.length; i++) {
              var k = root.variantKeys[i]
              o.push({ "value": k, "label": root.variantLabels[k] })
            }
            return o
          }
          value: root.variant
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          onChanged: root.setVariant(value)
        }

        Dropdown {
          id: cornerDropdown
          label: "CORNER"
          visible: root.effect === "Light Shafts"
          options: {
            var o = []
            for (var i = 0; i < root.cornerKeys.length; i++) {
              var k = root.cornerKeys[i]
              o.push({ "value": k, "label": root.cornerLabels[k] })
            }
            return o
          }
          value: root.corner
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          onChanged: root.setCorner(value)
        }

        Text {
          text: "STRAIGHTNESS  ·  " + Math.round(root.currentStraightness() * 10) / 10
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          Layout.alignment: Qt.AlignLeft
          Layout.topMargin: Style.space(6)
          visible: root.effect === "Light Shafts"
        }

        PanelSlider {
          id: straightnessSlider
          bar: root.bar
          value: root.currentStraightness()
          minimum: 0.0
          maximum: 2.0
          step: 0.1
          tickCount: 3
          visible: root.effect === "Light Shafts"
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          onMoved: root.straightnessPreview = value
          onReleased: {
            root.straightnessPreview = value
            root.setStraightness(Number(value.toFixed(1)))
          }
        }

        Text {
          text: (root.intensityLabels[root.effect] || "INTENSITY") + "  ·  " + Math.round(root.density * 10) / 10
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          Layout.alignment: Qt.AlignLeft
        }

        PanelSlider {
          id: densitySlider
          bar: root.bar
          value: root.density
          minimum: 1.0
          maximum: 3.0
          step: 0.1
          tickCount: 3
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          // Move the shader's spacing live while dragging; commit on release.
          onMoved: root.densityPreview = value
          onReleased: {
            root.densityPreview = value
            root.setDensity(Number(value.toFixed(1)))
          }
        }

        Text {
          text: (root.speedLabels[root.effect] || "SPEED") + "  ·  " + Math.round(root.speed * 100) / 100
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          Layout.alignment: Qt.AlignLeft
          Layout.topMargin: Style.space(6)
        }

        PanelSlider {
          id: speedSlider
          bar: root.bar
          value: root.speed
          minimum: 0.5
          maximum: 3.0
          step: 0.05
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          onMoved: root.speedPreview = value
          onReleased: {
            root.speedPreview = value
            root.setSpeed(Number(value.toFixed(2)))
          }
        }

        Text {
          text: "FRAMERATE  ·  " + Math.round(root.currentFps()) + " fps"
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          Layout.alignment: Qt.AlignLeft
          Layout.topMargin: Style.space(6)
        }

        PanelSlider {
          id: fpsSlider
          bar: root.bar
          value: root.currentFps()
          minimum: 15
          maximum: 60
          step: 1
          tickCount: 4
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          // Applies live while dragging (the ticker re-intervals instantly);
          // the value is committed to shell.json on release.
          onMoved: root.fpsPreview = value
          onReleased: {
            root.fpsPreview = value
            root.setFps(Number(value.toFixed(0)))
          }
        }

        Text {
          text: "RESOLUTION  ·  " + root.currentQuality().toFixed(1) + "x native"
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          Layout.alignment: Qt.AlignLeft
          Layout.topMargin: Style.space(6)
        }

        PanelSlider {
          id: qualitySlider
          bar: root.bar
          value: root.currentQuality()
          minimum: 0.5
          maximum: 2.0
          step: 0.5
          tickCount: 4
          Layout.fillWidth: true
          Layout.topMargin: Style.space(2)
          onMoved: root.qualityPreview = value
          onReleased: {
            root.qualityPreview = value
            root.setQuality(Number(value.toFixed(1)))
          }
        }

        RowLayout {
          spacing: Style.space(10)
          Layout.topMargin: Style.space(4)
          visible: root.rainyEffects.indexOf(root.effect) >= 0

          Toggle {
            id: lightningToggle
            label: "Lightning"
            checked: root.lightning
            titleSize: Style.font.body
            Layout.fillWidth: true
            onClicked: root.setLightning(!root.lightning)
          }
        }

        RowLayout {
          spacing: Style.space(10)
          Layout.topMargin: Style.space(4)
          visible: root.effect === "Aurora"

          Toggle {
            id: audioToggle
            label: "Audio reactive"
            checked: root.audio
            titleSize: Style.font.body
            Layout.fillWidth: true
            onClicked: root.setAudio(!root.audio)
          }
        }

        Text {
          text: root.keyNotice
          visible: root.keyNotice !== ""
          color: Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
          Layout.fillWidth: true
        }
      }
    }
  }

  // The effect surface, anchored to the monitor this bar widget lives on. It
  // rides the Background layer (under windows) instead of the overlay layer the
  // Scripture scrim uses, so the desktop moves beneath your apps.
  PanelWindow {
    id: rainWindow
    visible: root.raining
    screen: root.QsWindow && root.QsWindow.window ? root.QsWindow.window.screen : null
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "davidjm-rain"
    WlrLayershell.layer: WlrLayer.Background
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    mask: Region {}

    // --- effect render. The shader paints a full-screen FBO whose resolution
    // is `quality` × the window's (0.5x = quarter the pixels), captured by
    // ShaderEffectSource and stretched back over the whole screen by a cheap
    // sampling pass (upscale.frag). At native scale this is a 1:1 copy; at
    // 2x the effect is supersampled then downscaled for softer edges.
    Item {
      id: rainCanvas
      width: root.renderDimensions.width
      height: root.renderDimensions.height
      // uEffect selects the effect branch (0 = rain, 1 = snow, ... see the
      // effectIds map). `density` (1..3) and `speed` (0.5..3) are bounded;
      // each effect derives its own parameters from them. While a panel slider
      // is being dragged, the preview values drive these for a live look, then
      // the persisted (and injected) values take over on release. Values are
      // clamped so a hand-edited shell.json can't push the shader into NaN.
      ShaderEffect {
        id: rainFx
        anchors.fill: parent
        property vector2d uRes: Qt.vector2d(width, height)
        property real time: root.elapsed
        property real uIntensity: root.boundedNumber(root.densityPreview >= 0 ? root.densityPreview : root.density, 1, 1, 3)
        property real uSpeed: root.boundedNumber(root.speedPreview >= 0 ? root.speedPreview : root.speed, 1, 0.5, 3)
        property real uFlash: root.flash
        property real uStrike: root.strike
        property real uStrikeSeed: root.strikeSeed
        property vector2d uStrikePos: Qt.vector2d(root.strikeX, root.strikeLen)
        property real uEffect: root.effectIds[root.effect] !== undefined ? root.effectIds[root.effect] : 0
        property real uAudio: root.audioLevel
        property real uVariant: root.variant === "cherry" ? 1 : 0
        property real uCorner: root.corner === "tr" ? 1 : (root.corner === "bl" ? 2 : (root.corner === "br" ? 3 : 0))
        property real uStraightness: root.currentStraightness()
        vertexShader: Qt.resolvedUrl("rain.vert.qsb")
        fragmentShader: Qt.resolvedUrl("rain.frag.qsb")
      }
    }
    ShaderEffectSource {
      id: rainCapture
      sourceItem: rainCanvas
      live: root.raining
      hideSource: true
    }
    ShaderEffect {
      id: rainOutput
      anchors.fill: parent
      property variant source: rainCapture
      vertexShader: Qt.resolvedUrl("rain.vert.qsb")
      fragmentShader: Qt.resolvedUrl("upscale.frag.qsb")
    }
  }

  Timer {
    id: settingsWriteWatchdog
    interval: 5000
    repeat: false
    onTriggered: root.timeoutSettingsWrite()
  }

  // Persists settings to shell.json via the plugin's helper. Successful finds
  // are atomic (tmp + os.replace), which the shell's watched FileView picks up
  // and live-patches into this widget's `settings`.
  Process {
    id: configWriteProcess
    clearEnvironment: true
    environment: root.safeProcessEnvironment
    running: false
    stderr: StdioCollector {
      id: settingsErrorCollector
      waitForEnd: true
      onStreamFinished: root.lastSettingsDiagnostic = String(settingsErrorCollector.text || "").slice(0, 2048)
    }
    onExited: function(exitCode) {
      root.settingsProcessStopping = false
      var operation = root.activeSettingsWrite
      if (operation === null || operation.generation !== root.settingsWriteGeneration) {
        Qt.callLater(root.startSettingsWrite)
        return
      }
      settingsWriteWatchdog.stop()
      root.activeSettingsWrite = null
      if (exitCode === 0) {
        root.keyNotice = operation.successNotice
      } else {
        root.keyNotice = "Could not save settings."
        if ("running" in operation.changes) root.runningOverride = undefined
        if (root.lastSettingsDiagnostic) console.warn("omarchy-rain settings: " + root.lastSettingsDiagnostic)
      }
      Qt.callLater(root.startSettingsWrite)
    }
  }
}
