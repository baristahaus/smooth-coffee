// Feature extraction from an AnalyserNode: no DOM, no Web Audio types, just the
// two typed arrays that getFloatTimeDomainData / getFloatFrequencyData fill.
// That keeps the whole mood pipeline unit-testable from Node with synthesised
// frames — see tests/mood.test.mjs.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

const BAND_EDGES_HZ = [20, 160, 520, 2000, 6000, 20000];
const BAND_NAMES = ['bass', 'lowMid', 'mid', 'upper', 'air'];

// Krumhansl-Schmuckler key profiles; correlation against a rotated copy of one
// of these is the standard cheap way to tell major from minor without pitch
// tracking. https://en.wikipedia.org/wiki/Krumhansl%E2%80%93Schmuckler_profile
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const CHROMA_HZ = [40, 4200];
const TEMPO_HISTORY_SECONDS = 8;
const TEMPO_ENVELOPE_HZ = 40;
const BPM_MIN = 66;
const BPM_MAX = 185;

function correlate(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    dot += da * db;
    normA += da * da;
    normB += db * db;
  }
  const denom = Math.sqrt(normA * normB);
  return denom < 1e-9 ? 0 : dot / denom;
}

// rotate(profile, r) must put the profile's tonic peak (index 0) on pitch class r.
const rotate = (profile, root) =>
  profile.map((_, index) => profile[(((index - root) % 12) + 12) % 12]);

export class AudioFeatureTracker {
  /** @param {{sampleRate: number, fftSize: number}} opts as configured on the AudioContext */
  constructor({ sampleRate = 48000, fftSize = 2048 } = {}) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.hzPerBin = sampleRate / fftSize;
    this.previousMagnitude = null;
    this.loudnessHistory = [];
    this.envelopeBuckets = [];
    this.bpm = 0;
    this.bpmConfidence = 0;
    this.pulse = 0;
    this.magnitudes = new Float32Array(fftSize / 2);
    this.lastPulseAt = 0;
  }

  setSampleRate(sampleRate) {
    if (sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate;
      this.hzPerBin = sampleRate / this.fftSize;
    }
  }

  reset() {
    this.previousMagnitude = null;
    this.loudnessHistory.length = 0;
    this.envelopeBuckets.length = 0;
    this.lastPulseAt = 0;
    this.bpm = 0;
    this.bpmConfidence = 0;
    this.pulse = 0;
  }

  /**
   * @param {number} nowMs performance-clock milliseconds
   * @param {Float32Array} wave time domain, -1..1, analyser.fftSize long
   * @param {Float32Array} fftDb magnitude in dB, analyser.frequencyBinCount long
   */
  update(nowMs, wave, fftDb) {
    const rms = rootMeanSquare(wave);
    const db = 20 * Math.log10(rms + 1e-7);
    const magnitude = this.toMagnitudes(fftDb);
    const spectrum = analyseSpectrum(magnitude, this.hzPerBin);
    const flux = this.fluxAgainst(magnitude);
    const chroma = chromaFrom(magnitude, this.hzPerBin);
    const tonality = tonalityFrom(chroma);

    this.remember(nowMs, db, flux);
    this.trackPulse(nowMs, flux);

    const loudnessSpread = std(this.loudnessHistory.map((entry) => entry.db));

    return {
      time: nowMs,
      rms,
      db,
      zeroCrossingRate: zeroCrossings(wave) * this.sampleRate,
      ...spectrum,
      flux,
      loudnessSpread,
      chroma,
      ...tonality,
      bpm: this.bpm,
      bpmConfidence: this.bpmConfidence,
      pulse: this.pulse,
      silent: rms < 0.0015,
    };
  }

  toMagnitudes(fftDb) {
    const out = this.magnitudes;
    const floorDb = -110;
    for (let i = 0; i < out.length; i++) {
      const value = fftDb[i] === -Infinity ? floorDb : Math.max(fftDb[i], floorDb);
      out[i] = Math.pow(10, value / 20);
    }
    return out;
  }

  fluxAgainst(magnitude) {
    const previous = this.previousMagnitude;
    if (!previous) {
      this.previousMagnitude = Float32Array.from(magnitude);
      return 0;
    }
    let rising = 0;
    let total = 0;
    for (let i = 0; i < magnitude.length; i++) {
      const delta = magnitude[i] - previous[i];
      if (delta > 0) rising += delta;
      total += magnitude[i];
      previous[i] = magnitude[i];
    }
    return rising / (total + 1e-6);
  }

  remember(nowMs, db, flux) {
    pushWindow(this.loudnessHistory, { t: nowMs, db }, TEMPO_HISTORY_SECONDS * 1000);

    const bucketMs = 1000 / TEMPO_ENVELOPE_HZ;
    const bucket = Math.round(nowMs / bucketMs);
    const last = this.envelopeBuckets[this.envelopeBuckets.length - 1];
    if (!last || last.bucket !== bucket) {
      this.envelopeBuckets.push({ bucket, flux });
    } else {
      last.flux = Math.max(last.flux, flux);
    }
    const oldestBucket = this.envelopeBuckets[0];
    while (this.envelopeBuckets.length > TEMPO_HISTORY_SECONDS * TEMPO_ENVELOPE_HZ) {
      this.envelopeBuckets.shift();
    }
    if (this.envelopeBuckets[0] !== oldestBucket) this.estimateTempo();
  }

  estimateTempo() {
    const buckets = this.envelopeBuckets;
    const first = buckets[0]?.bucket;
    const last = buckets.at(-1)?.bucket;
    if (first === undefined || last - first + 1 < TEMPO_ENVELOPE_HZ * 3) return;

    // requestAnimationFrame is not a fixed clock: materialise every missing 25 ms
    // bucket, otherwise a lag counted in samples is not a lag in seconds and the
    // whole estimate slides with the frame rate.
    const signal = new Array(last - first + 1).fill(0);
    for (const entry of buckets) signal[entry.bucket - first] = entry.flux;
    const mean = signal.reduce((sum, value) => sum + value, 0) / signal.length;
    for (let i = 0; i < signal.length; i++) signal[i] -= mean;
    if (signal.every((value) => Math.abs(value) < 1e-9)) return;

    const minLag = Math.round((60 / BPM_MAX) * TEMPO_ENVELOPE_HZ);
    const maxLag = Math.floor((60 / BPM_MIN) * TEMPO_ENVELOPE_HZ);
    const scores = [];
    let bestLag = 0;
    let bestScore = 0;
    let scoreSum = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < signal.length; i++) sum += signal[i] * signal[i + lag];
      const bpm = (60 * TEMPO_ENVELOPE_HZ) / lag;
      // Nudge towards the common 90-140 band so half/double-time mistakes settle
      // on the reading a listener would name.
      const plausibility = 1 - 0.35 * Math.min(1, Math.abs(Math.log2(bpm / 116)) / 1.2);
      const score = Math.max(0, sum) * plausibility;
      scores[lag] = score;
      scoreSum += score;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    if (!bestLag || bestScore <= 0) return;

    // Parabolic peak interpolation: 40 Hz buckets alone only give ~4 BPM steps.
    const before = scores[bestLag - 1] ?? 0;
    const after = scores[bestLag + 1] ?? 0;
    const curvature = before - 2 * bestScore + after;
    const offset = curvature === 0 ? 0 : clamp((0.5 * (before - after)) / curvature, -0.5, 0.5);
    let bpm = (60 * TEMPO_ENVELOPE_HZ) / (bestLag + offset);

    const meanScore = scoreSum / (maxLag - minLag + 1);
    const confidence = clamp01(Math.log2(bestScore / (meanScore || 1e-9)) / 1.5);

    // Hold the previous tempo when it is close, or when the newcomer is weaker.
    if (this.bpm && Math.abs(Math.log2(bpm / this.bpm)) < 0.03) bpm += (this.bpm - bpm) * 0.75;
    else if (this.bpm && confidence < this.bpmConfidence * 0.8) bpm = this.bpm;

    this.bpm = bpm;
    this.bpmConfidence = confidence;
  }

  trackPulse(nowMs, flux) {
    const dt = this.lastPulseAt ? Math.min(0.5, (nowMs - this.lastPulseAt) / 1000) : 0.016;
    this.lastPulseAt = nowMs;
    this.pulse *= Math.exp(-dt / 0.22);
    const baseline = median(this.envelopeBuckets.map((entry) => entry.flux));
    if (flux > Math.max(0.012, baseline * 2.2)) this.pulse = Math.min(1, this.pulse + 0.9);
  }
}

function rootMeanSquare(wave) {
  let sum = 0;
  for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
  return Math.sqrt(sum / wave.length);
}

function zeroCrossings(wave) {
  let crossings = 0;
  for (let i = 1; i < wave.length; i++) {
    if (wave[i - 1] < 0 !== wave[i] < 0) crossings++;
  }
  return crossings / (wave.length - 1);
}

function analyseSpectrum(magnitude, hzPerBin) {
  const bands = {};
  for (const name of BAND_NAMES) bands[name] = 0;
  let energy = 0;
  let weightedHz = 0;
  const cumulative = [];

  for (let bin = 0; bin < magnitude.length; bin++) {
    const value = magnitude[bin] * magnitude[bin];
    const hz = bin * hzPerBin;
    energy += value;
    weightedHz += value * hz;
    cumulative.push(energy);
    for (let b = 0; b < BAND_NAMES.length; b++) {
      if (hz >= BAND_EDGES_HZ[b] && hz < BAND_EDGES_HZ[b + 1]) bands[BAND_NAMES[b]] += value;
    }
  }

  const rolloffShare = cumulative.at(-1) ?? 0;
  const rolloffIndex = rolloffShare > 0 ? cumulative.findIndex((value) => value >= 0.85 * rolloffShare) : -1;
  const rolloffHz = rolloffIndex >= 0 ? rolloffIndex * hzPerBin : 0;

  const normalise = {};
  for (const name of BAND_NAMES) normalise[name] = energy > 1e-9 ? bands[name] / energy : 0;

  return {
    energy,
    centroidHz: energy > 1e-9 ? weightedHz / energy : 0,
    rolloffHz,
    brightness: normalise.upper + normalise.air,
    bass: normalise.bass,
    lowMid: normalise.lowMid,
    mid: normalise.mid,
    upper: normalise.upper,
    air: normalise.air,
  };
}

/** Fold magnitude into 12 pitch classes; drums and pad noise wash out, harmony does not. */
function chromaFrom(magnitude, hzPerBin) {
  const chroma = new Array(12).fill(0);
  const firstBin = Math.max(1, Math.floor(CHROMA_HZ[0] / hzPerBin));
  const lastBin = Math.min(magnitude.length - 1, Math.ceil(CHROMA_HZ[1] / hzPerBin));
  for (let bin = firstBin; bin <= lastBin; bin++) {
    const hz = bin * hzPerBin;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const rounded = Math.round(midi);
    const spread = 1 - Math.abs(midi - rounded) * 2;
    const weight = magnitude[bin] * Math.max(0, spread);
    chroma[((rounded % 12) + 12) % 12] += weight;
  }
  const peak = Math.max(...chroma);
  return peak > 1e-9 ? chroma.map((v) => v / peak) : chroma;
}

function tonalityFrom(chroma) {
  if (chroma.every((v) => v < 1e-6)) return { modeScore: 0, tonalConfidence: 0, keyName: null };
  let bestMajor = { score: -2, root: 0 };
  let bestMinor = { score: -2, root: 0 };
  for (let root = 0; root < 12; root++) {
    const major = correlate(chroma, rotate(MAJOR_PROFILE, root));
    const minor = correlate(chroma, rotate(MINOR_PROFILE, root));
    if (major > bestMajor.score) bestMajor = { score: major, root };
    if (minor > bestMinor.score) bestMinor = { score: minor, root };
  }
  const noteNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const major = bestMajor.score >= bestMinor.score;
  const winner = major ? bestMajor : bestMinor;
  return {
    modeScore: clamp(bestMajor.score - bestMinor.score, -1, 1),
    tonalConfidence: clamp01(Math.max(bestMajor.score, bestMinor.score)),
    keyName: `${noteNames[winner.root]} ${major ? 'major' : 'minor'}`,
  };
}

function pushWindow(window, entry, horizonMs) {
  window.push(entry);
  while (window.length && entry.t - window[0].t > horizonMs) window.shift();
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function std(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

/**
 * One-sided smoothing: react fast to energy arriving, slowly to it leaving.
 */
export function follow(previous, target, dt, attackSeconds, releaseSeconds) {
  const tau = target > previous ? attackSeconds : releaseSeconds;
  return previous + (target - previous) * (1 - Math.exp(-dt / tau));
}

export { clamp, clamp01 };
