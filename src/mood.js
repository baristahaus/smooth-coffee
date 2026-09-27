// Feature vector -> mood. Two independent axes, following Russell's circumplex:
//
//   valence  is the "major / bright / gentle" vs "minor / dark / harsh" axis
//   arousal  is the "calm / slow / quiet" vs "driving / loud / busy" axis
//
// Everything is deliberately boring arithmetic with named weights, because the
// only honest way to tune "mood" is to watch the numbers move next to the music.

import { blendMood } from './palettes.js';
import { clamp, clamp01 } from './features.js';

const W = {
  // valence
  mode: 0.34, //            modeScore is the correlation gap between major and minor profiles
  brightness: 0.16, //      above-average spectral brightness reads as lighter
  harshness: -0.26, //      hiss, distortion, clipped highs read as negative
  // arousal
  loudness: 0.42,
  flux: 0.30, //            how fast the spectrum is changing = activity
  tempo: 0.28, //           weighted by tempo confidence
  roughness: 0.14,
};

const NORM = {
  quietDb: -46, //          rms dB mapped to 0
  loudDb: -12, //           rms dB mapped to 1
  centroidHz: [220, 2600], // midpoint = neutral brightness
  fluxFull: 0.22, //        flux value that counts as fully active
  bpm: [70, 170],
  spreadDb: [0.5, 7], //    dynamics within the last 8 s
  harshFloor: 0.22, //      upper+air share below this is "clean"
};

const span = (value, [lo, hi]) => clamp01((value - lo) / (hi - lo));

/** Pure, stateless assessment of one frame. Exported so tests can pin behaviour. */
export function assess(features) {
  const loudness = span(features.db, [NORM.quietDb, NORM.loudDb]);
  const brightness = span(features.centroidHz, NORM.centroidHz);
  const flux = clamp01(features.flux / NORM.fluxFull);
  const tempo = span(features.bpm, NORM.bpm) * clamp01(features.bpmConfidence * 1.6);
  const dynamics = span(features.loudnessSpread, NORM.spreadDb);
  const harshness = clamp01((features.brightness - NORM.harshFloor) * 2.2);
  const mode = clamp(features.modeScore * 2.6, -1, 1) * clamp01(0.35 + features.tonalConfidence);

  let valence = 0.5 + W.mode * mode + W.brightness * (brightness - 0.5) * 2 + W.harshness * harshness;
  let arousal =
    0.1 +
    W.loudness * loudness +
    W.flux * flux +
    W.tempo * (tempo - 0.5) * 2 * 0.5 +
    W.roughness * harshness +
    0.1 * dynamics;

  if (features.silent) {
    valence = 0.5;
    arousal = 0.06;
  }

  return {
    valence: clamp01(valence),
    arousal: clamp01(arousal),
    signals: { loudness, brightness, flux, tempo, dynamics, harshness, mode },
  };
}

/**
 * Mood with memory. Valence lags further behind the music than arousal does:
 * a fill should make the field surge, but one minor-ising chord should not flip
 * the whole room from warm to cold and back within a bar.
 */
export class MoodFollower {
  constructor({ valenceTau = 4.0, arousalTau = 1.6, idleAfterMs = 8000 } = {}) {
    this.valenceTau = valenceTau;
    this.arousalTau = arousalTau;
    this.idleAfterMs = idleAfterMs;
    this.valence = 0.5;
    this.arousal = 0.15;
    this.lastLoudAt = 0;
    this.idle = 1;
  }

  reset(nowMs = 0) {
    this.valence = 0.5;
    this.arousal = 0.15;
    this.lastLoudAt = nowMs;
    this.idle = 1;
  }

  update(nowMs, features) {
    const assessment = assess(features);
    const dt = this.previousAt ? Math.min(0.5, (nowMs - this.previousAt) / 1000) : 0.016;
    this.previousAt = nowMs;

    if (!features.silent) {
      const alphaValence = 1 - Math.exp(-dt / this.valenceTau);
      const alphaArousal = 1 - Math.exp(-dt / this.arousalTau);
      this.valence += (assessment.valence - this.valence) * alphaValence;
      this.arousal += (assessment.arousal - this.arousal) * alphaArousal;
    }

    if (features.db > NORM.quietDb + 4) this.lastLoudAt = nowMs;
    const silenceMs = nowMs - this.lastLoudAt;
    const idleTarget = silenceMs > this.idleAfterMs ? 1 : 0;
    this.idle += (idleTarget - this.idle) * (1 - Math.exp(-dt / 2.5));

    // Idle does not change the palette: it only dims and slows the scene, and it
    // does that in the renderer, so a paused player fades rather than recolours.
    const mood = blendMood(this.valence, this.arousal);
    return {
      valence: this.valence,
      arousal: this.arousal,
      instant: assessment,
      name: this.idle > 0.5 ? 'Idle' : mood.name,
      colors: mood.colors,
      motion: mood.motion,
      idle: this.idle,
      keyName: features.keyName,
      tonalConfidence: features.tonalConfidence,
      bpm: features.bpm,
      bpmConfidence: features.bpmConfidence,
      signals: assessment.signals,
    };
  }
}
