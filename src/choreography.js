// Choreography for staged scenes: what the room does over minutes rather than
// frames. Kept DOM-free and side-effect-free so the timing rules are testable
// with a synthetic clock (tests/choreography.test.mjs).
//
// The reason this exists at all is burn-in. A "scene" wants a stable composition;
// an OLED panel wants nothing to be stable. The compromise is a camera that is
// never still, plus a vantage that changes completely every so often, so no pixel
// shows the same content for long even though each frame looks composed.

const TAU = Math.PI * 2;

/** No confident beat: figures breathe at this period instead of swaying to a pulse. */
export const REST_BEAT_SECONDS = 5.5;
/** How long the framing holds before the room "recomposes" to another vantage. */
export const VANTAGE_SECONDS = 660;
/** Cross-fade length between vantages; long enough to read as a slow move. */
export const VANTAGE_FADE_SECONDS = 14;

/**
 * Framings, in stage units. `x`/`y` move the camera pivot, `zoom` scales about it.
 * Alternating wide and tight means an hour of this scene is several different
 * pictures, which is the point.
 */
export const VANTAGES = [
  { x: 0.00, y: -0.02, zoom: 1.00 },
  { x: -0.26, y: 0.05, zoom: 1.18 },
  { x: 0.22, y: -0.06, zoom: 0.94 },
  { x: 0.04, y: 0.10, zoom: 1.28 },
  { x: -0.18, y: -0.08, zoom: 1.04 },
];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Deterministic 1-D value noise for the flicker; no Math.random anywhere. */
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(t) {
  const i = Math.floor(t);
  const f = t - i;
  const shaped = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), shaped) * 2 - 1;
}

export function createChoreography() {
  return {
    swayPhase: 0,          // in beats, integrated so tempo changes never jump
    presence: 0,           // 0 = empty room, 1 = band playing
    flicker: 1,
    camera: { x: 0, y: 0, zoom: 1 },
    lamp: { x: 0, y: 0.52 },
    vantage: 0,
    vantageMix: 0,
    haze: 0.4,
    beam: 0.5,
  };
}

/**
 * @param {object} room     mutable state from createChoreography()
 * @param {number} dt       seconds since last frame
 * @param {object} input    { clock, bpm, bpmConfidence, arousal, idle, pulse, bass }
 * @returns {object} room, for chaining
 */
export function stepChoreography(room, dt, input) {
  const clock = input.clock ?? 0;
  const arousal = input.arousal ?? 0.5;
  const idle = input.idle ?? 1;
  // Sway: a beat is a beat only if the tempo estimate is confident and usable.
  // Clamped so a wild estimate cannot turn the trio into a strobe or freeze it.
  const confident = Number.isFinite(input.bpm) && input.bpm > 0 && (input.bpmConfidence ?? 0) > 0.3;
  const beatSeconds = confident ? Math.min(2, Math.max(0.25, 60 / input.bpm)) : REST_BEAT_SECONDS;
  room.swayPhase += dt / beatSeconds;

  // The band is only present while there is music.
  const presenceTarget = 1 - clamp01(idle);
  const presenceTau = presenceTarget > room.presence ? 1.2 : 6.5; // arrive quickly, leave slowly
  room.presence += (presenceTarget - room.presence) * (1 - Math.exp(-dt / presenceTau));

  // Lamp flicker: mostly steady, with occasional dips, and a gas-lamp wobble.
  const fast = smoothNoise(clock * 7.3);
  const slow = smoothNoise(clock * 0.9);
  room.flicker = 0.94 + 0.05 * slow + 0.035 * fast + 0.05 * (input.pulse ?? 0);

  // Never-still camera: two Lissajous pans plus a long zoom breath, all summed
  // onto the current vantage.
  const panX = 0.030 * Math.sin((TAU * clock) / 83) + 0.014 * Math.sin((TAU * clock) / 37);
  const panY = 0.022 * Math.sin((TAU * clock) / 127 + 1.3);
  const zoomBreath = 1 + 0.045 * Math.sin((TAU * clock) / 143);

  const slot = clock / VANTAGE_SECONDS;
  const from = Math.floor(slot) % VANTAGES.length;
  const within = (slot - Math.floor(slot)) * VANTAGE_SECONDS;
  const to = (from + 1) % VANTAGES.length;
  room.vantage = from;
  room.vantageMix = within > VANTAGE_SECONDS - VANTAGE_FADE_SECONDS
    ? (within - (VANTAGE_SECONDS - VANTAGE_FADE_SECONDS)) / VANTAGE_FADE_SECONDS
    : 0;

  const a = VANTAGES[from];
  const b = VANTAGES[to];
  const eased = room.vantageMix * room.vantageMix * (3 - 2 * room.vantageMix);
  room.camera.x = lerp(a.x, b.x, eased) + panX;
  room.camera.y = lerp(a.y, b.y, eased) + panY;
  room.camera.zoom = lerp(a.zoom, b.zoom, eased) * zoomBreath;

  // The lamp hangs from the ceiling but is not anchored to the room: it swings
  // slowly so the light shaft sweeps the panel.
  room.lamp.x = 0.13 * Math.sin((TAU * clock) / 97) + 0.05 * Math.sin((TAU * clock) / 23);
  room.lamp.y = 0.52 + 0.03 * Math.sin((TAU * clock) / 61);

  // Haze thickens with activity and thins (never vanishes) when the room is empty.
  const hazeTarget = 0.30 + 0.55 * arousal + 0.25 * (input.bass ?? 0);
  room.haze += (hazeTarget - room.haze) * (1 - Math.exp(-dt / 2.0));
  room.beam = 0.55 + 0.45 * (input.bass ?? 0) + 0.35 * (input.pulse ?? 0);

  return room;
}
