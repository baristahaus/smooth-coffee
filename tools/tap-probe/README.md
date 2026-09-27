---
# tap-probe

Answers one question that decides how `smooth-coffee-ai2` gets built: **can a Core
Audio tap be heard by a process other than the one that created it?**

If yes, the browser can select a published tap with `getUserMedia` and the whole
BlackHole / Multi-Output Device setup — including the dead volume keys — goes away.
If no, the helper has to ship PCM over a WebSocket instead, which assumes nothing.

Nobody has answered this in public: Apple's own sample and every implementation I
could find (AudioCap, AudioTee, MiniMeters, Longwave) create a **private** tap and
read it in-process. This probe creates a **public** tap, wraps it in a **published**
aggregate (`kAudioAggregateDeviceIsPrivateKey = 0`, tap autostart on), and then gets
out of the way so other processes can look.

## Run it

```bash
cd tools/tap-probe
./bundle.sh
```

`bundle.sh` builds with SwiftPM, assembles a minimal `.app` (TCC will not grant audio
capture to a bare CLI binary on current macOS) and runs the binary **inside** that
bundle from your terminal, so its output stays where you can read it. Play some music
first — the probe has nothing to tap otherwise.

On first run macOS asks for **Screen & System Audio Recording**. If it does not ask and
calls return `'nope'` (1852797029), check System Settings → Privacy & Security → Screen
& System Audio Recording, tick the probe, and run it again.

## The two things to paste back

While the probe is running, from a *different* terminal:

```bash
system_profiler SPAudioDataType | grep -iA10 smoothcoffee
```

and in Brave, on the visualiser page, in the devtools console:

```js
const s = await navigator.mediaDevices.getUserMedia({
  audio: { deviceId: { exact: (await navigator.mediaDevices.enumerateDevices())
    .find(d => d.label.includes('SmoothCoffee'))?.deviceId ?? '' } }, video: false });
const c = new AudioContext(); const a = c.createAnalyser();
c.createMediaStreamSource(s).connect(a);
const buf = new Float32Array(a.fftSize);
setInterval(() => { a.getFloatTimeDomainData(buf);
  console.log('rms', Math.sqrt(buf.reduce((n, v) => n + v * v, 0) / buf.length).toFixed(5)); }, 500);
```

| observation | conclusion |
|---|---|
| device listed **and** rms moves with the music | public taps cross processes → delete the virtual driver from the design |
| device listed, rms stays 0 | published but not delivered → WebSocket transport |
| device not listed at all | publishing a tap aggregate is not a thing → WebSocket transport |

## Honest caveat

This file has **never been compiled**. The machine it was written on is Linux with no
macOS SDK, so `swift build` here is impossible. Expect at worst a small typo-level fix;
paste the compiler error and it will be corrected.
