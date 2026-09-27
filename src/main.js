import { Renderer } from './renderer.js';
import { AudioFeatureTracker, follow } from './features.js';
import { MoodFollower } from './mood.js';
import { Hud } from './hud.js';
import { MOOD_ANCHORS } from './palettes.js';
import { unlockDeviceLabels, listInputs, chooseInput, openInput } from './capture.js';

const PREFERENCES_KEY = 'smooth-coffee.v1';
// 8192 for a reason: at 48 kHz that is 5.86 Hz per bin, which resolves semitones
// up to ~1 kHz and therefore makes the major/minor chroma estimate meaningful.
const FFT_SIZE = 8192;
const TAU = Math.PI * 2;

// Burn-in defence: nothing in the composition is allowed to hold still. These
// periods are mutually prime-ish so the combined pattern never repeats within a
// working day, and the whole field pans by ~4.5% of screen height.
const DRIFT = {
  panSeconds: 97,
  tiltSeconds: 143,
  breathSeconds: 71,
  glowXSeconds: 211,
  glowYSeconds: 167,
};

// What the field looks like before any audio has been seen: dim, slow, still drifting.
const IDLE_MOTION = { flow: 0.04, turbulence: 0.35, contrast: 0.85, pulseGain: 0.1, glow: 0.4, grain: 0.012 };

const QUALITY_STEPS = [1, 0.85, 0.7, 0.55, 0.45];

// Band shares are ratios that sum to 1, so a naive linear map pins the loud bands
// at full scale for anything tonal. This curve keeps them monotonic with headroom:
// a share of 0.3 at gain 3.2 reads 0.49, and even a share of 1.0 only reaches 0.76.
const saturate = (share, gain) => {
  const x = Math.max(0, share) * gain;
  return Math.min(1, (1.25 * x) / (1 + x));
};
const SILENCE = {
  silent: true, rms: 0, db: -120, flux: 0, bpm: 0, bpmConfidence: 0, pulse: 0,
  centroidHz: 0, bass: 0, lowMid: 0, mid: 0, upper: 0, air: 0, brightness: 0,
  loudnessSpread: 0, modeScore: 0, tonalConfidence: 0, keyName: null,
  zeroCrossingRate: 0, rolloffHz: 0, energy: 0, time: 0,
};

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(PREFERENCES_KEY)) ?? {};
  } catch {
    return {};
  }
};

export class SmoothCoffee {
  constructor(elements) {
    this.el = elements;
    this.prefs = load();
    this.renderer = new Renderer(elements.canvas);
    this.tracker = new AudioFeatureTracker({ sampleRate: 48000, fftSize: FFT_SIZE });
    this.follower = new MoodFollower();
    this.hud = new Hud(elements.hud);
    this.renderer.renderScale = QUALITY_STEPS.includes(this.prefs.scale) ? this.prefs.scale : 1;
    this.renderer.resize();
    this.capture = null;
    this.device = null;
    this.status = 'idle';
    this.warning = null;
    this.lockedMood = -1;
    this.quality = { scale: this.renderer.renderScale, frameTimes: [], checkedAt: 0 };
    this.scene = {
      clock: 0,
      sceneTime: 0,
      drift: { x: 0, y: 0 },
      glow: { x: 0, y: 0 },
      breath: 1,
      lift: this.prefs.lift ?? 0.62,
      idle: 1,
      grain: 0.012,
      contrast: 1,
      flow: 0.1,
      turbulence: 0.6,
      pulseGain: 0.3,
      glowGain: 0.6,
      bands: { bass: 0, mid: 0, air: 0 },
      pulse: 0,
      colors: [[0.04, 0.05, 0.09], [0.16, 0.16, 0.26], [0.4, 0.42, 0.5]],
    };
    this.startedAt = performance.now();
    this.lastFrameAt = this.startedAt;
    this.lastHudAt = 0;
    this.features = SILENCE;
    this.mood = {
      name: 'Idle', valence: 0.5, arousal: 0.15, bpm: 0, bpmConfidence: 0,
      idle: 1, keyName: null, signals: {}, motion: IDLE_MOTION,
    };
  }

  savePreferences() {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
      deviceId: this.device?.deviceId ?? null,
      label: this.device?.label ?? null,
      lift: this.scene.lift,
      scale: this.quality.scale,
    }));
  }

  /** Step 1 is the permission click; without a grant there are no labels to match. */
  async start() {
    this.status = 'requesting microphone';
    // No paint here: the loop that draws starts once a capture exists.
    let inputs = [];
    try {
      inputs = await unlockDeviceLabels();
    } catch (error) {
      this.status = 'permission denied';
      this.warning = `${error.name}: grant Brave microphone access, then reload`;
      throw error;
    }
    const device = chooseInput(inputs, { preferredId: this.prefs.deviceId });
    if (!device) {
      this.status = 'no input device';
      this.warning = 'No audio input at all — install BlackHole (see README) and reload';
      throw new Error('no audioinput devices');
    }
    await this.switchTo(device.deviceId);
    this.hud.start();
    this.attachListeners();
    this.scheduleFrame();
  }

  async switchTo(deviceId) {
    const inputs = await listInputs();
    const device = inputs.find((entry) => entry.deviceId === deviceId)
      ?? chooseInput(inputs, { preferredId: deviceId });
    if (!device) throw new Error(`device ${deviceId} disappeared`);

    this.capture?.close();
    this.capture = await openInput(device, { fftSize: FFT_SIZE });
    this.device = device;
    this.tracker.reset();
    this.follower.reset(performance.now());
    this.tracker.setSampleRate(this.capture.context.sampleRate);
    this.status = 'capturing';
    this.warning = !/blackhole|eqmac|loopback|virtual|aggregate/i.test(device.label)
      ? `using "${device.label}" — not a loopback driver, expecting a microphone`
      : null;
    this.capture.track.addEventListener('ended', () => this.onCaptureLost());
    this.capture.track.addEventListener('mute', () => { this.warning = `track muted by the OS`; this.hud.noteActivity(); });
    this.savePreferences();
  }

  onCaptureLost() {
    this.capture?.close();
    this.capture = null;
    this.status = 'input lost';
    this.warning = 'capture stopped — press P to pick a device again';
  }

  attachListeners() {
    addEventListener('resize', () => this.renderer.resize());
    addEventListener('devicechange', async () => {
      if (!this.capture) return;
      const inputs = await listInputs();
      const still = inputs.some((entry) => entry.deviceId === this.device?.deviceId);
      if (!still) {
        this.onCaptureLost();
        const fallback = chooseInput(inputs, { preferredId: null });
        if (fallback) this.switchTo(fallback.deviceId).catch(() => {});
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastFrameAt = performance.now();
        this.scheduleFrame();
      }
    });
    addEventListener('keydown', (event) => this.handleKey(event));
    addEventListener('pointermove', () => this.hud.noteActivity());
    addEventListener('pointerdown', () => this.hud.noteActivity());
  }

  handleKey(event) {
    this.hud.noteActivity();
    const key = event.key.toLowerCase();
    if (key === 'f') {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } else if (key === 'h') {
      this.el.gate.classList.add('hidden');
      this.hud.toggle();
    } else if (key === 'p') {
      this.el.picker.classList.toggle('hidden');
      void this.refreshInputs().then(() => this.fillDeviceList());
    } else if (key === 'r') {
      this.tracker.reset();
      this.follower.reset(performance.now());
    } else if (key === '[' || key === ']') {
      this.scene.lift = Math.min(0.95, Math.max(0.22, this.scene.lift + (key === ']' ? 0.05 : -0.05)));
      this.savePreferences();
    } else if (key === '0') {
      this.lockedMood = -1;
    } else if (/^[1-9]$/.test(key)) {
      this.lockedMood = Number(key) - 1;
    }
  }

  fillDeviceList() {
    const list = this.el.pickerList;
    list.replaceChildren();
    for (const device of this.cachedInputs ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = device.label || device.deviceId.slice(0, 8);
      button.dataset.deviceId = device.deviceId;
      button.dataset.current = device.deviceId === this.device?.deviceId ? 'true' : 'false';
      button.addEventListener('click', async () => {
        this.el.picker.classList.add('hidden');
        try {
          await this.switchTo(device.deviceId);
        } catch (error) {
          this.warning = String(error.message ?? error);
        }
      });
      list.append(button);
    }
  }

  /** Keep the device list current so the picker reflects hot-plugs. */
  async refreshInputs() {
    this.cachedInputs = await listInputs();
    return this.cachedInputs;
  }

  buildScene(dt) {
    const { scene, features, mood } = this;
    const clock = (performance.now() - this.startedAt) / 1000;
    const idle = mood.idle;
    const motion = mood.motion;

    scene.clock = clock;
    scene.sceneTime += dt * (0.22 + motion.flow * 2.6) * (1 - 0.75 * idle);
    scene.drift.x = Math.sin((TAU * clock) / DRIFT.panSeconds);
    scene.drift.y = Math.sin((TAU * clock) / DRIFT.tiltSeconds + 1.7);
    scene.glow.x = 0.26 * Math.sin((TAU * clock) / DRIFT.glowXSeconds);
    scene.glow.y = 0.18 * Math.sin((TAU * clock) / DRIFT.glowYSeconds + 0.9);
    scene.breath = 1 + 0.045 * Math.sin((TAU * clock) / DRIFT.breathSeconds);
    scene.idle = idle;
    scene.grain = motion.grain;
    scene.contrast = motion.contrast;
    scene.flow = motion.flow;
    scene.turbulence = motion.turbulence * (1 - 0.4 * idle);
    scene.pulseGain = motion.pulseGain;
    scene.glowGain = motion.glow * (1 - 0.55 * idle);

    scene.bands.bass = follow(scene.bands.bass, saturate(features.bass, 3.2), dt, 0.05, 0.3);
    scene.bands.mid = follow(scene.bands.mid, saturate(features.mid + features.lowMid, 2.6), dt, 0.07, 0.35);
    scene.bands.air = follow(scene.bands.air, saturate(features.air, 6.5), dt, 0.04, 0.25);
    scene.pulse = follow(scene.pulse, features.pulse * (1 - idle), dt, 0.015, 0.2);
    scene.colors = mood.colors ?? scene.colors;
    return scene;
  }

  /** Frame pacing is measured every frame; the HUD and the scale choice read it. */
  recordFrame(now) {
    const times = this.quality.frameTimes;
    times.push(now);
    if (times.length > 120) times.shift();
  }

  adaptQuality(now) {
    const state = this.quality;
    if (state.frameTimes.length < 90 || now - state.checkedAt < 1500) return;
    state.checkedAt = now;

    const recent = state.frameTimes.slice(-60);
    const meanMs = (recent.at(-1) - recent[0]) / Math.max(1, recent.length - 1);
    const index = QUALITY_STEPS.indexOf(state.scale);
    if (meanMs > 22 && index < QUALITY_STEPS.length - 1) {
      state.scale = QUALITY_STEPS[index + 1];
      this.renderer.setRenderScale(state.scale);
      this.savePreferences();
    } else if (meanMs < 12 && index > 0) {
      state.scale = QUALITY_STEPS[Math.max(0, index - 1)];
      this.renderer.setRenderScale(state.scale);
      this.savePreferences();
    }
  }

  frame(now) {
    this.scheduleFrame();
    const dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    this.recordFrame(now);

    if (this.capture) {
      this.capture.read();
      this.features = this.tracker.update(now, this.capture.wave, this.capture.fftDb);
    } else {
      this.features = { ...SILENCE, time: now };
    }
    this.mood = this.follower.update(now, this.features);

    if (this.lockedMood >= 0) {
      const anchor = MOOD_ANCHORS[this.lockedMood];
      this.follower.valence += (anchor.valence - this.follower.valence) * (1 - Math.exp(-dt / 0.7));
      this.follower.arousal += (anchor.arousal - this.follower.arousal) * (1 - Math.exp(-dt / 0.7));
      this.mood = this.follower.update(now, this.features);
    }

    this.render(dt);
    this.adaptQuality(now);

    if (now - this.lastHudAt > 200) {
      this.lastHudAt = now;
      this.hud.update(this.state());
    }
  }

  render(dt) {
    this.renderer.render(this.buildScene(dt));
  }

  /** Everything the HUD and an automated check need to see. */
  state() {
    const recent = this.quality.frameTimes.slice(-30);
    const fps = recent.length > 1 ? (recent.length - 1) * 1000 / (recent.at(-1) - recent[0]) : 0;
    return {
      status: this.status,
      deviceLabel: this.device?.label ?? 'none',
      moodName: this.lockedMood >= 0 ? `${MOOD_ANCHORS[this.lockedMood].name} (locked)` : this.mood.name,
      valence: this.mood.valence,
      arousal: this.mood.arousal,
      loudness: this.mood.signals?.loudness ?? 0,
      bpm: this.mood.bpm,
      bpmConfidence: this.mood.bpmConfidence,
      keyName: this.mood.keyName,
      modeScore: this.features.modeScore ?? 0,
      centroidHz: this.features.centroidHz ?? 0,
      rms: this.features.rms ?? 0,
      idle: this.mood.idle,
      fps,
      scale: this.quality.scale,
      lift: this.scene.lift,
      warning: this.warning,
      colors: this.scene.colors.map((stop) => stop.map((v) => Math.round(v * 1000) / 1000)),
      backingPixels: this.renderer.backingPixels,
    };
  }

  scheduleFrame() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = document.hidden ? 0 : requestAnimationFrame((now) => this.frame(now));
  }
}

async function boot() {
  const elements = {
    canvas: document.querySelector('#field'),
    hud: document.querySelector('#hud'),
    gate: document.querySelector('#gate'),
    picker: document.querySelector('#picker'),
    pickerList: document.querySelector('#device-list'),
    message: document.querySelector('#gate-message'),
  };
  let app;
  try {
    app = new SmoothCoffee(elements);
  } catch (error) {
    elements.message.textContent = error.message;
    elements.gate.dataset.state = 'failed';
    return;
  }
  window.viz = app;
  elements.gate.dataset.state = 'ready';

  document.querySelector('#start').addEventListener('click', async () => {
    elements.message.textContent = 'grant the microphone prompt, then pick the loopback driver if asked';
    try {
      await app.start();
      await app.refreshInputs();
      elements.gate.classList.add('hidden');
    } catch (error) {
      elements.message.textContent = `could not start: ${error.message}`;
      elements.gate.dataset.state = 'failed';
    }
  });
}

if (document.querySelector('#field')) void boot();
