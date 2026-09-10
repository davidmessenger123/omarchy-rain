import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import Quickshell.Io
import qs.Commons
import qs.Ui

// Rain — animated desktop rain. A full-screen layer-shell surface mapped on the
// same `Background` layer Omarchy's wallpaper uses, so the drops fall over the
// desktop while every window (and the bar) stays composited on top. A GPU
// fragment shader paints the rain, so once running it costs almost no CPU.
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
  property real density: Number(root.effective("density", 2)) || 2
  property real speed: Number(root.effective("speed", 1.0)) || 1.0
  property bool lightning: root.effective("lightning", true)

  // While a settings slider is being dragged, the preview values drive the
  // shader immediately; they clear when the persisted settings come back
  // through the shell's live patch (see persistSettings -> onSettingsChanged).
  property real densityPreview: -1
  property real speedPreview: -1

  // Active lightning strike: amount (0..1, animated with a flicker), the
  // per-strike seed/position/length that fix the bolt's shape for its short
  // flash, and the sky-behind-it glow.
  property real strike: 0.0
  property real strikeSeed: 0.0
  property real strikeX: 0.5
  property real strikeLen: 0.6

  property bool settingsOpen: false
  property bool raining: false
  property real elapsed: 0.0
  property real flash: 0.0
  property string keyNotice: ""

  // Absolute path to this plugin's folder, resolved from the QML file itself so
  // settings persistence finds its neighbor write_settings.py wherever the
  // plugin lives.
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")

  // This widget's live entry from the shell's layout config — the authoritative
  // copy of its parameters the bar is currently running with.
  function selfEntry() {
    var lc = root.bar ? root.bar.layoutConfig : null
    if (!lc) return null
    for (var r = 0; r < 3; r++) {
      var region = ["left", "center", "right"][r]
      var list = lc[region]
      if (!list) continue
      for (var i = 0; i < list.length; i++) {
        if (list[i] && (list[i].id || "") === "davidjm.rain") return list[i]
      }
    }
    return null
  }

  function effective(name, fallback) {
    var v = root.setting(name, undefined)
    if (v !== undefined && v !== null) return v
    var entry = root.selfEntry()
    var e = entry ? entry[name] : undefined
    return (e === undefined || e === null) ? fallback : e
  }

  function toggle() {
    root.raining = !root.raining
  }

  function toggleSettings() {
    root.settingsOpen = !root.settingsOpen
    if (root.settingsOpen) {
      root.keyNotice = ""
      root.densityPreview = -1
      root.speedPreview = -1
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
    root.densityPreview = -1
    root.speedPreview = -1
  }

  function setDensity(value) {
    root.persistSettings({ "density": value })
    root.keyNotice = "Saved — intensity " + Number(value).toFixed(1) + "."
  }

  function setSpeed(value) {
    root.persistSettings({ "speed": value })
    root.keyNotice = "Saved — speed " + Number(value).toFixed(2) + "."
  }

  function setLightning(on) {
    root.persistSettings({ "lightning": on })
    root.keyNotice = on ? "Saved — lightning on." : "Saved — lightning off."
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

  function persistSettings(changes) {
    configWriteProcess.command = [
      "python3",
      root.pluginDir + "/write_settings.py",
      JSON.stringify(changes)
    ]
    configWriteProcess.running = true
  }

  // Drives the shader's `time` uniform while the rain is visible. Keeping the
  // surface hidden when off means the compositor never composites it.
  Timer {
    id: ticker
    interval: 16
    repeat: true
    running: root.raining
    onTriggered: root.elapsed = root.elapsed + 0.016
  }

  // Random lightning. Sometimes a distant storm front just flashes the sky,
  // sometimes it fires an actual bolt (see fireStrike and the shader's
  // lighting). The interval drifts so strikes never feel metronomic.
  Timer {
    id: stormClock
    interval: 3400
    repeat: true
    running: root.raining && root.lightning
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

  Behavior on flash {
    enabled: root.raining
    NumberAnimation { duration: 340; easing.type: Easing.OutCubic }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\ue3b8"
    tooltipText: "Rain — rain over the desktop wallpaper"
    horizontalMargin: 8.25
    verticalPadding: 7.5
    active: root.raining

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) root.toggleSettings()
      else root.toggle()
    }
  }

  // Right-click settings menu — rainfall intensity (continuous), fall speed,
  // and lightning. Changes apply live while dragging and persist to shell.json
  // on release (live-patched by the shell, so no restart needed).
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
      onCloseRequested: root.closeSettings()
      onActivateRequested: {
        if (lightningToggle.activeFocus) root.setLightning(!root.lightning)
      }
      onReturnRequested: {
        if (lightningToggle.activeFocus) root.setLightning(!root.lightning)
      }

      ColumnLayout {
        id: form
        anchors.fill: parent
        spacing: Style.space(8)

        Text {
          text: "RAIN SETTINGS"
          color: Color.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          font.bold: true
          font.letterSpacing: 2
        }

        Text {
          text: "INTENSITY  ·  " + Math.round(root.density * 10) / 10
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
          text: "RAINFALL SPEED  ·  " + Math.round(root.speed * 100) / 100
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

        RowLayout {
          spacing: Style.space(10)
          Layout.topMargin: Style.space(4)

          Toggle {
            id: lightningToggle
            label: "Lightning"
            checked: root.lightning
            titleSize: Style.font.body
            Layout.fillWidth: true
            onClicked: root.setLightning(!root.lightning)
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

  // The rain surface, anchored to the monitor this bar widget lives on. It
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

    ShaderEffect {
      anchors.fill: parent
      // intensity 1..3 maps 0.65..1.6 (column spacing divisor); speed 0.5..3
      // scales fall velocity. While a panel slider is being dragged, the
      // preview values drive these for a live look, then the persisted (and
      // injected) values take over on release.
      property vector2d uRes: Qt.vector2d(width, height)
      property real time: root.elapsed
      property real uIntensity: 0.65 + (root.densityPreview >= 0 ? root.densityPreview : root.density - 1.0) * 0.475
      property real uSpeed: root.speedPreview >= 0 ? root.speedPreview : root.speed
      property real uFlash: root.flash
      property real uStrike: root.strike
      property real uStrikeSeed: root.strikeSeed
      property vector2d uStrikePos: Qt.vector2d(root.strikeX, root.strikeLen)
      vertexShader: Qt.resolvedUrl("rain.vert.qsb")
      fragmentShader: Qt.resolvedUrl("rain.frag.qsb")
    }
  }

  // Persists settings to shell.json via the plugin's helper. Successful finds
  // are atomic (tmp + os.replace), which the shell's watched FileView picks up
  // and live-patches into this widget's `settings`.
  Process {
    id: configWriteProcess
    running: false
  }
}