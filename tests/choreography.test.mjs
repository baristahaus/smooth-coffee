// Choreography is pure arithmetic on a clock, so the timing rules that matter for
// burn-in and for "the band moves with the music" can be pinned exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createChoreography, stepChoreography, REST_BEAT_SECONDS, VANTAGES, VANTAGE_SECONDS, VANTAGE_FADE_SECONDS,
} from '../src/choreography.js';

const run = (seconds, input, dt = 1 / 60) => {
  const room = createChoreography();
  let clock = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    clock += dt;
    stepChoreography(room, dt, { clock, idle: 0, ...input });
  }
  return room;
};

test('sway is measured in beats, so the trio moves with the tempo', () => {
  const room = run(4, { bpm: 120, bpmConfidence: 1 });
  assert.ok(Math.abs(room.swayPhase - 8) < 0.05, `4 s at 120 BPM should be 8 beats, got ${room.swayPhase}`);
});

test('without a confident beat the figures breathe at the rest rate', () => {
  const room = run(4, { bpm: 120, bpmConfidence: 0.1 });
  const expected = 4 / REST_BEAT_SECONDS;
  assert.ok(Math.abs(room.swayPhase - expected) < 0.02, `expected ${expected}, got ${room.swayPhase}`);
});

test('a tempo change continues the phase instead of jumping it', () => {
  const room = createChoreography();
  let clock = 0;
  const advance = (seconds, bpm) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) {
      clock += 1 / 60;
      stepChoreography(room, 1 / 60, { clock, bpm, bpmConfidence: 1, idle: 0 });
    }
  };
  advance(2, 120);
  const halfway = room.swayPhase;
  advance(2, 90);
  assert.ok(Math.abs(halfway - 4) < 0.05, `2 s at 120 should be 4 beats, got ${halfway}`);
  assert.ok(Math.abs(room.swayPhase - (halfway + 3)) < 0.06, 'the second half should add exactly 3 beats at 90 BPM');
});

test('the framing recomposes on schedule and fades between vantages', () => {
  const room = createChoreography();
  stepChoreography(room, 1 / 60, { clock: 600, idle: 0 });
  assert.equal(room.vantage, 0);
  assert.equal(room.vantageMix, 0);

  stepChoreography(room, 1 / 60, { clock: VANTAGE_SECONDS - VANTAGE_FADE_SECONDS / 2, idle: 0 });
  assert.equal(room.vantage, 0, 'still framing vantage 0 mid-fade');
  assert.ok(room.vantageMix > 0.4 && room.vantageMix < 0.6, `mid-fade mix was ${room.vantageMix}`);

  stepChoreography(room, 1 / 60, { clock: VANTAGE_SECONDS + 5, idle: 0 });
  assert.equal(room.vantage, 1);
  assert.equal(room.vantageMix, 0);
  // Vantage 1 pulls left and in; the camera must have moved at least the pan margin.
  assert.ok(room.camera.x < VANTAGES[0].x, `camera x was ${room.camera.x}`);
  assert.ok(room.camera.zoom > VANTAGES[0].zoom, `camera zoom was ${room.camera.zoom}`);
});

test('the band arrives quickly and leaves slowly', () => {
  const room = createChoreography();
  assert.ok(run(0.1, {}, 1 / 60).presence >= 0);

  const arrived = run(3, { idle: 0 });
  assert.ok(arrived.presence > 0.9, `presence after 3 s of music was ${arrived.presence}`);

  let clock = 0;
  for (let elapsed = 0; elapsed < 20; elapsed += 1 / 60) {
    clock += 1 / 60;
    stepChoreography(arrived, 1 / 60, { clock, idle: 1 });
  }
  assert.ok(arrived.presence < 0.05, `after 20 s of silence the room should be empty, presence ${arrived.presence}`);
});

test('nothing in the room holds still across ten minutes', () => {
  const sampled = [];
  const room = createChoreography();
  let clock = 0;
  for (let elapsed = 0; elapsed < 600; elapsed += 1 / 60) {
    clock += 1 / 60;
    stepChoreography(room, 1 / 60, { clock, bpm: 100, bpmConfidence: 0.8, arousal: 0.5, idle: 0 });
    if (elapsed % 20 < 1 / 60) sampled.push([room.camera.x, room.camera.y, room.camera.zoom, room.lamp.x]);
  }
  const unique = new Set(sampled.map((entry) => entry.map((v) => v.toFixed(6)).join(',')));
  assert.equal(unique.size, sampled.length, 'every 20 s sample should be a different framing');
  const xs = sampled.map((entry) => entry[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.05, 'the camera should pan across the panel');
});

test('hostile inputs stay finite', () => {
  const room = createChoreography();
  stepChoreography(room, 0, { clock: 0 });
  stepChoreography(room, 0.016, { clock: 1, bpm: 0, bpmConfidence: 0, arousal: undefined, idle: undefined });
  stepChoreography(room, 0.016, { clock: 2, bpm: Number.NaN, bpmConfidence: 1, pulse: 0, bass: 0 });
  for (const value of [room.swayPhase, room.presence, room.flicker, room.camera.x, room.camera.zoom, room.lamp.x, room.haze, room.beam]) {
    assert.ok(Number.isFinite(value), `${value} is not finite`);
  }
});
