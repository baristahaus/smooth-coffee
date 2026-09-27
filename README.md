# Smooth Coffee

Full-screen audio-reactive field for macOS. It reads the Mac's **system audio** through a
loopback input device, estimates the **mood** of what is playing (valence × arousal), and paints
a slow, dim, drifting colour field for an OLED panel. Music keeps playing through your speakers
or headphones the whole time.

No build step, no dependencies: ES modules, one WebGL1 fragment shader, a Python dev server.

---

## 1. One-time macOS routing

The browser cannot see system audio. It can only open an **input** device, so the mix has to be
copied to one. `getUserMedia` never touches the output path, so nothing here mutes your speakers.

### The setup that works (BlackHole, free)

```bash
brew install blackhole-2ch
```

Audio MIDI Setup (`open -a "Audio MIDI Setup"`) → bottom-left `+` → **Create Multi-Output Device**:

1. Tick **MacBook Pro Speakers** (or your DAC/headphones) **first**, and make it the **Master Device**.
   BlackHole's own FAQ: due to macOS bugs the built-in output must be enabled and listed at the top.
2. Tick **BlackHole 2ch**.
3. Enable **Drift Correction** for every device *except* the master.
4. Name it `Visualiser Loop`. Right-click it → **Use This Device For Sound Output**.

That is the whole trick: your speakers and BlackHole receive the same stream, and the browser
records BlackHole. **System output = Visualiser Loop**, and in the visualiser press `P` and choose
**BlackHole 2ch**.

Costs worth knowing before you commit to this:

- macOS will not change the volume of a Multi-Output Device — your volume keys stop working while
  it is the output. Set levels per device in Audio MIDI Setup, or use
  `brew install switchaudio-osx; SwitchAudioSource -s "MacBook Pro Speakers" -t output` when you
  want control back.
- Everything you capture, you also send: nothing is recorded to disk, but macOS shows the orange
  microphone indicator while the visualiser runs.
- Bluetooth is a bad companion for this: the extra hop plus drift correction invites glitches.
  Wired/USB/built-in output is the reliable case.

### If eqMac is already installed

eqMac's driver device also exposes its input side as a **microphone**, and the app finds it
automatically (the label looks like `MacBook Pro Speakers (eqMac)` because newer versions mirror
the real device name). Three things to expect:

- the captured audio is the **raw, pre-EQ** system mix — eqMac's own maintainer: *"the eqMac mic
  outputs exactly what it gets, so it's before any processing and EQ"* ([#824][eq824], [#819][eq819]);
  post-EQ export is eqMac's "Virtual Output", still listed Pro and In Development
- the device is **hidden when eqMac is not running**, and a settings toggle (added in v1.6.2) can
  hide it entirely, so a quit eqMac means a visualiser with no input
- eqMac refuses to be the *default* input device (`CanBeDefaultDevice = 0` on its input scope), so
  the explicit `deviceId: {exact}` selection this app uses is mandatory, not a nicety.

Free eqMac is enough for this project — the driver and the capture path are not Pro features. The
Pro list is Expert EQ, Spectrum Analyzer, L/R EQ, AU hosting, Spatial, App Mixer, custom UI.

[eq824]: https://github.com/bitgapp/eqMac/issues/824
[eq819]: https://github.com/bitgapp/eqMac/issues/819

### Check the route before opening the browser

```bash
system_profiler SPAudioDataType | grep -iA6 blackhole     # must show Input Channels: 2
SwitchAudioSource -c -t output                            # should print Visualiser Loop
```

## 2. Run it

```bash
./run.sh              # http://127.0.0.1:8765/  (localhost is a secure context, so no TLS needed)
```

Open it in **Brave** → **Start capturing** → allow the microphone twice (Brave's own prompt, then
macOS → Settings → Privacy & Security → Microphone → Brave). Click, press `F`, done.

`curl`-style note: `http://localhost` works too, but `http://127.0.0.1` avoids any IPv6 surprise.

## 3. Controls

| Key | Effect |
|---|---|
| `F` | fullscreen |
| `H` | readout on/off |
| `P` | device picker (switch input without reloading) |
| `[` `]` | brightness ceiling 0.22 … 0.95, default 0.62 |
| `1`–`9` | hold a mood anchor, to audition palettes |
| `0` | release the anchor |
| `R` | reset tempo/mood memory |

Mouse or key activity shows the readout for 5 s, then it fades and the cursor hides.
Lift, render scale and last device persist in `localStorage`.

## 4. How the mood is derived

`AnalyserNode` (fftSize 8192 → 5.86 Hz bins, smoothing off — the app does its own) feeds
`src/features.js`, then `src/mood.js`, then `src/palettes.js`.

| Feature | How | Feeds |
|---|---|---|
| loudness | RMS → dB → 0..1 over −46…−12 dB | arousal |
| activity | spectral flux (positive bin deltas), normalised | arousal, pulse |
| tempo | autocorrelation of a 40 Hz onset envelope over 8 s, plausibility-weighted 66–185 BPM, parabolic peak, hysteresis | arousal |
| mode | Krumhansl–Schmuckler correlation of a 12-bin chroma against rotated major/minor profiles | valence, key name |
| brightness | spectral centroid over 220…2600 Hz | valence |
| harshness | energy above 2 kHz (hiss, clipping, inharmonic noise) | valence −, arousal + |
| dynamics | std of loudness over the last 8 s | arousal |

Valence and arousal are smoothed with different time constants (4 s and 1.6 s): a drum fill should
make the field surge, a single minor-ising chord must not flip the room's colour inside a bar.

Ten anchors sit on the circumplex — Euphoric, Radiant, Dreamy, Serene, Solemn, Melancholic,
Mysterious, Tense, Fierce, Ambient. Every frame the palette and motion parameters are an
inverse-square blend of *all* of them, so the look slides continuously between anchors instead of
snapping between ten presets. Each anchor also carries motion (`flow`, `turbulence`, `contrast`,
`pulseGain`, `glow`, `grain`): calm music is slower and less turbulent by construction, not only
by colour. That is the seam the later "smoke room with jazz musicians" scene hangs off — it gets
the same `{colors, motion, bands, pulse, valence, arousal}` contract.

The field itself is domain-warped fBm (`fbm(p + fbm(p + fbm(p)))`), coloured by three stops, with a
bass-driven glow core, ridge filaments driven by mids and air, high-frequency sparkle, and grain.

## 5. What protects the OLED

Burn-in comes from static *contrast*, so all of these are in place at once:

| Mechanism | Where |
|---|---|
| whole-field pan, 97 s × 143 s Lissajous, ±4.5 % of height | `DRIFT` + `uDrift` |
| glow source wanders on 211 s / 167 s periods, vignette follows it | `uGlow` |
| brightness ceiling with soft roll-off — default `lift` 0.62, nothing sits at panel maximum | shader tone map |
| 4.5 % "breathing" of the ceiling on a 71 s cycle | `uBreath` |
| hue wear-levelling: 6–13 % channel rotation on a ~5.5 min cycle, so a repeated palette does not age the same subpixels | shader `mix(color, color.brg, …)` |
| readout: hidden by default, 5 s fade, dim (`--ink` 62 % alpha), cycles corners every 45 s | `hud.js` |
| start gate text drifts slowly while it is up, and disappears on first capture | `styles.css` |
| no signal for 8 s → 2.5 s fade to a dim, slow, still-moving idle field (never a frozen frame) | `MoodFollower.idle` |
| per-pixel dither so large dark gradients do not band into static contours | `uGrain` |
| adaptive render scale (1 → 45 %) keeps frame time sane on a 4 K panel | `adaptQuality` |

Measured on real frames (Chromium, software GL, 1440×757, lift 0.62): luma average 86/255,
99th percentile 119/255, max 124/255. Two frames 20 s apart differ in 98.5 % of pixels (96 % in the
centre 300×200 region) — no pixel is holding a value.

If you drive a bright OLED TV, start with `[` to pull the ceiling toward 0.45 and leave the readout
off with `H`.

## 6. Layout

```
index.html      canvas + start gate + readout + device picker
styles.css      dark UI, readout auto-hide and corner cycling
devserver.py    localhost server, Cache-Control: no-store so reload = the code you just wrote
run.sh          ./run.sh [port]
src/capture.js  permission unlock, device choice, getUserMedia constraints, source→analyser
src/features.js flux, bands, centroid, chroma/key, tempo, pulse          (DOM-free)
src/mood.js     features → valence/arousal with memory                   (DOM-free)
src/palettes.js ten circumplex anchors + continuous blend                 (DOM-free)
src/renderer.js WebGL1 field, render-scale management
src/hud.js      readout text/bars, auto-hide, corner cycling
src/main.js     glue: loop, scene assembly, keys, adaptive quality, persistence
tests/mood.test.mjs  node --test over synthesised analyser frames
```

`features.js`, `mood.js` and `palettes.js` deliberately touch no DOM: the whole mood path is
testable with typed arrays, so it can be reasoned about without audio hardware.

```bash
node --test tests/     # 8 tests: major/minor split, valence/arousal ordering, 120/90/150 BPM,
                       # jittered frame clock, silence→idle, extremes stay finite, reset
```

## 7. Limits and next steps

- **Mood is heuristic, not learned.** One chord, one drum fill or a very dense mix can move the
  needle for a few seconds; the smoothing limits the damage but does not remove it. Audition
  palettes with `1`–`9` and decide what you actually want before blaming the analysis.
- **`getUserMedia` is mono-aware but stereo-honest**: Chrome reports 2 channels; there is no
  cross-channel analysis yet, so a hard-panned mix reads as one blob.
- **Not tested on Safari or Firefox.** Both support the APIs used here; Safari has had
  `deviceId: {exact}` regressions in `applyConstraints` (WebKit bug 230819), which is why the device
  is chosen at `getUserMedia` time and switched by reopening the stream rather than by constraint.
- **Per-process capture is the better long-term source.** macOS 14.2+ Core Audio taps
  (`CATapDescription`, `AudioHardwareCreateProcessTap`, `AudioHardwareTap` on macOS 15+) can tap the
  global mixdown or a single app without hijacking your output device, behind *Screen & System
  Audio Recording*. A ~200-line helper streaming Float32 PCM over WebSocket would remove the
  Multi-Output Device and its dead volume keys. Tracked in beads.
- The **smoke room with jazz musicians** belongs as a second renderer behind the same scene
  contract; the mood layer should not change.
