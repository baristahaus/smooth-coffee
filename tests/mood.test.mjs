// Behavioural tests for the analysis half of the visualiser: the same two
// modules the browser runs, driven with synthesised analyser frames.
//
// Frequencies are chosen as exact multiples of the FFT bin width so a frame
// here looks exactly like what an AnalyserNode reports for a steady tone:
// energy in one bin, floor everywhere else, no leakage arguments.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AudioFeatureTracker } from '../src/features.js';
import { assess, MoodFollower } from '../src/mood.js';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 8192;
const BIN_HZ = SAMPLE_RATE / FFT_SIZE; // 5.859375
const FLOOR_DB = -110;
const FRAME_MS = 1000 / 60;

/** @param {Array<{bin: number, amplitude: number}>} partials */
function toneFrame(partials) {
  const wave = new Float32Array(FFT_SIZE);
  const fftDb = new Float32Array(FFT_SIZE / 2).fill(FLOOR_DB);
  for (const { bin, amplitude } of partials) {
    fftDb[bin] = 20 * Math.log10(amplitude);
    const hz = bin * BIN_HZ;
    for (let i = 0; i < wave.length; i++) {
      wave[i] += amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    }
  }
  for (let i = 0; i < wave.length; i++) wave[i] = Math.max(-1, Math.min(1, wave[i] / 2));
  return { wave, fftDb };
}

const harmonic = (bin, amplitude, count = 3) =>
  Array.from({ length: count }, (_, index) => ({ bin: bin * (index + 1), amplitude: amplitude / (index + 1) }));

// A = bin 38 (222.7 Hz), C = 45, C# = 47, E = 56. One bin pair separates the two
// triads, which is what a real recording of a major and minor chord looks like.
const A_MAJOR = [...harmonic(38, 0.5), ...harmonic(47, 0.34, 2), ...harmonic(56, 0.3, 2)];
const A_MINOR = [...harmonic(38, 0.5), ...harmonic(45, 0.34, 2), ...harmonic(56, 0.3, 2)];

// Kick: low thump plus broadband transient, so spectral flux sees an onset.
const KICK = [{ bin: 10, amplitude: 0.8 }, ...Array.from({ length: 240 }, (_, i) => ({ bin: 30 + i, amplitude: 0.05 }))];

function run(frames, { seconds = 6, from = 0 } = {}) {
  const tracker = new AudioFeatureTracker({ sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
  const total = Math.round((seconds * 1000) / FRAME_MS);
  let last;
  for (let i = 0; i < total; i++) {
    const at = from + i * FRAME_MS;
    const { wave, fftDb } = frames(i, at);
    last = tracker.update(at, wave, fftDb);
  }
  return { tracker, last };
}

const steady = (partials) => () => toneFrame(partials);

test('major and minor triads are distinguishable and opposite-signed', () => {
  const major = run(steady(A_MAJOR), { seconds: 4 }).last;
  const minor = run(steady(A_MINOR), { seconds: 4 }).last;
  assert.ok(major.modeScore > 0.05, `major modeScore was ${major.modeScore}`);
  assert.ok(minor.modeScore < -0.05, `minor modeScore was ${minor.modeScore}`);
  assert.equal(major.keyName, 'A major');
  assert.equal(minor.keyName, 'A minor');
});

test('valence follows mode, arousal follows activity', () => {
  const major = run(steady(A_MAJOR), { seconds: 4 }).last;
  const minor = run(steady(A_MINOR), { seconds: 4 }).last;
  assert.ok(assess(major).valence > assess(minor).valence, 'major should read brighter than minor');

  const quiet = run(steady(A_MAJOR.map((p) => ({ ...p, amplitude: p.amplitude * 0.12 }))), { seconds: 4 }).last;
  const busy = run((i) => (i % 15 === 0 ? toneFrame(KICK) : toneFrame(A_MAJOR)), { seconds: 4 }).last;
  const quietScore = assess(quiet).arousal;
  const busyScore = assess(busy).arousal;
  assert.ok(busyScore > quietScore + 0.15, `busy ${busyScore} should beat quiet ${quietScore}`);
});

test('a four-on-the-floor click train reads as 120 BPM', () => {
  const beatFrames = Math.round((60 / 120) * 1000 / FRAME_MS); // 30 frames
  const { tracker } = run((i) => (i % beatFrames === 0 ? toneFrame(KICK) : toneFrame(A_MINOR)), { seconds: 9 });
  assert.ok(tracker.bpm > 112 && tracker.bpm < 128, `bpm was ${tracker.bpm}`);
  assert.ok(tracker.bpmConfidence > 0.2, `confidence was ${tracker.bpmConfidence}`);
});

test('half-time and double-time clicks both land on the notated beat', () => {
  for (const bpm of [90, 150]) {
    const beatFrames = Math.round((60 / bpm) * 1000 / FRAME_MS);
    const { tracker } = run((i) => (i % beatFrames === 0 ? toneFrame(KICK) : toneFrame(A_MAJOR)), { seconds: 9 });
    assert.ok(Math.abs(tracker.bpm - bpm) < bpm * 0.08, `${bpm} BPM read as ${tracker.bpm}`);
  }
});

test('silence is detected, and the mood follower fades to idle', () => {
  const silentFrame = toneFrame([]);
  const { last } = run(() => silentFrame, { seconds: 2 });
  assert.equal(last.silent, true);
  assert.equal(last.rms, 0);

  const tracker = new AudioFeatureTracker({ sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
  const follower = new MoodFollower({ idleAfterMs: 8000 });
  follower.reset(0);
  const loudFrame = toneFrame(A_MAJOR);
  let mood;
  const play = (from, seconds, frame) => {
    for (let i = 0; i < 60 * seconds; i++) {
      const at = from + i * FRAME_MS;
      mood = follower.update(at, tracker.update(at, frame.wave, frame.fftDb));
    }
    return mood;
  };
  assert.ok(play(0, 8, loudFrame).idle < 0.1, 'playing music must not read as idle');
  assert.ok(play(8000, 20, silentFrame).idle > 0.98, 'long silence must fade to idle');
  assert.equal(mood.name, 'Idle');
});

test('features stay finite at the very quiet and the very loud extremes', () => {
  const whisper = run(steady(A_MAJOR.map((p) => ({ ...p, amplitude: p.amplitude * 0.002 }))), { seconds: 3 }).last;
  const shout = run(steady(A_MAJOR.map((p) => ({ ...p, amplitude: Math.min(0.9, p.amplitude * 6) }))), { seconds: 3 }).last;
  for (const features of [whisper, shout]) {
    const mood = assess(features);
    assert.ok(Number.isFinite(mood.valence) && Number.isFinite(mood.arousal));
    assert.ok(mood.valence >= 0 && mood.valence <= 1);
    assert.ok(mood.arousal >= 0 && mood.arousal <= 1);
    assert.ok(Number.isFinite(features.centroidHz) && Number.isFinite(features.flux));
    assert.ok(features.rolloffHz > 0, 'rolloff should track the audible band');
  }
});

test('reset clears learned tempo and the tracker keeps working', () => {
  const beatFrames = 30;
  const { tracker } = run((i) => (i % beatFrames === 0 ? toneFrame(KICK) : toneFrame(A_MAJOR)), { seconds: 9 });
  assert.ok(tracker.bpm > 100, `expected a learned tempo, got ${tracker.bpm}`);
  tracker.reset();
  assert.equal(tracker.bpm, 0);
  assert.equal(tracker.bpmConfidence, 0);
  const after = tracker.update(9000, toneFrame(A_MAJOR).wave, toneFrame(A_MAJOR).fftDb);
  assert.ok(Number.isFinite(after.rms) && Number.isFinite(after.flux));
});

test('tempo survives the irregular frame clock of requestAnimationFrame', () => {
  // A real rAF loop delivers 40-60 Hz with jitter; buckets then arrive out of a
  // regular grid, which must not bend the beat estimate.
  const tracker = new AudioFeatureTracker({ sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
  const beatSeconds = 0.5; // 120 BPM
  let at = 0;
  let tick = 0;
  while (at < 11000) {
    const seconds = at / 1000;
    const onBeat = seconds % beatSeconds < 0.03;
    const frame = toneFrame(onBeat ? KICK : A_MAJOR);
    tracker.update(at, frame.wave, frame.fftDb);
    at += 1000 / (38 + (tick++ % 5)); // 38-42 fps, deliberately uneven
  }
  assert.ok(tracker.bpm > 112 && tracker.bpm < 128, `bpm was ${tracker.bpm}`);
});
