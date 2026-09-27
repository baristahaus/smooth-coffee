// The smoke room: a lamp, a beam through haze, and a trio that sways to the beat.
//
// Why this is safe on an OLED when a "scene" normally would not be:
//   * the camera is never still (two pans + a zoom breath) and reframes the room
//     onto a new vantage every 11 minutes, so the composition itself moves;
//   * the lamp swings, so the bright shaft — the only high-emission object — is
//     always over different pixels;
//   * the musicians, piano and table are *absorbing*: they subtract light, so the
//     static geometry in this scene is the dimmest thing on the panel;
//   * haze, motes and flicker are noise-driven and never repeat within a frame time.

export const smokeRoomScene = {
  id: 'smoke-room',
  label: 'Smoke room',
  fragment: `
precision highp float;

uniform vec2  uRes;
uniform float uClock;
uniform float uSceneTime;
uniform float uLift;
uniform float uBreath;
uniform float uIdle;
uniform float uGrain;
uniform float uContrast;
uniform float uBass;
uniform float uMid;
uniform float uAir;
uniform float uPulse;
uniform float uGlowGain;
uniform float uHaze;
uniform float uBeam;
uniform float uSway;       // accumulated beats
uniform float uPresence;   // 0 empty room … 1 band playing
uniform float uFlicker;
uniform vec3  uCamera;     // pivot x, pivot y, zoom
uniform vec2  uLamp;
uniform vec3  uDeepColor;
uniform vec3  uMidColor;
uniform vec3  uHighColor;

const float TAU = 6.2831853;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * vnoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amplitude *= 0.5;
  }
  return value;
}

float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdEllipse(vec2 p, vec2 c, vec2 r) {
  return (length((p - c) / r) - 1.0) * min(r.x, r.y);
}

float sdBox(vec2 p, vec2 c, vec2 b) {
  vec2 d = abs(p - c) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/** Bodies lean from the hips; the amount of lean is mood-independent, the rate is not. */
vec2 sway(vec2 p, float phase) {
  float height = smoothstep(-0.34, 0.22, p.y);
  p.x += sin(TAU * uSway + phase) * 0.016 * height;
  p.y += sin(TAU * uSway * 0.5 + phase * 1.7) * 0.004 * height;
  return p;
}

// Upright bass: the tall diagonal is what makes it read as a bass player.
float bassSDF(vec2 p) {
  float d = sdCapsule(p, vec2(-0.02, -0.30), vec2(0.0, 0.05), 0.052);
  d = min(d, sdEllipse(p, vec2(0.0, 0.095), vec2(0.036, 0.040)));
  d = min(d, sdEllipse(p, vec2(0.0, 0.132), vec2(0.062, 0.010)));      // brim
  d = min(d, sdCapsule(p, vec2(0.055, -0.20), vec2(0.105, 0.10), 0.030)); // neck
  d = min(d, sdEllipse(p, vec2(0.075, -0.13), vec2(0.052, 0.075)));    // body
  d = min(d, sdCapsule(p, vec2(0.02, -0.02), vec2(0.07, -0.10), 0.018)); // arm
  return d;
}

float saxSDF(vec2 p) {
  float d = sdCapsule(p, vec2(0.0, -0.29), vec2(0.01, 0.04), 0.048);
  d = min(d, sdEllipse(p, vec2(0.01, 0.085), vec2(0.034, 0.038)));
  d = min(d, sdCapsule(p, vec2(0.0, 0.0), vec2(0.085, -0.05), 0.019));
  d = min(d, sdCapsule(p, vec2(0.03, -0.01), vec2(0.12, -0.12), 0.017));
  d = min(d, sdEllipse(p, vec2(0.145, -0.145), vec2(0.034, 0.026)));   // bell
  return d;
}

float pianistSDF(vec2 p) {
  float d = sdCapsule(p, vec2(0.0, -0.16), vec2(-0.01, 0.03), 0.050);
  d = min(d, sdEllipse(p, vec2(-0.01, 0.072), vec2(0.033, 0.036)));
  d = min(d, sdCapsule(p, vec2(0.0, -0.02), vec2(-0.13, -0.075), 0.017));
  d = min(d, sdEllipse(p, vec2(0.0, -0.14), vec2(0.075, 0.030)));      // seated lap
  return d;
}

/** Furniture never sways: the piano, its stool, the bassist's rug, the front table. */
float furnitureSDF(vec2 p, float presence) {
  float d = sdBox(p, vec2(-0.34, -0.175), vec2(0.235, 0.070));         // grand piano body
  d = min(d, sdBox(p, vec2(-0.40, -0.055), vec2(0.180, 0.012)));       // lid
  d = min(d, sdBox(p, vec2(-0.30, -0.30), vec2(0.020, 0.070)));        // leg
  d = min(d, sdCapsule(p, vec2(0.30, -0.30), vec2(0.30, -0.16), 0.030)); // drum stool
  d = min(d, sdEllipse(p, vec2(0.30, -0.15), vec2(0.075, 0.016)));
  float table = sdEllipse(p, vec2(0.055, -0.44), vec2(0.30, 0.062));   // front table
  return min(d, table / max(presence, 0.25));
}

void main() {
  vec2 ndc = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 sp = (ndc - uCamera.xy) * uCamera.z;

  // Room: dim wall with plaster texture, darker floor below the line.
  float plaster = fbm(sp * 3.4 + vec2(0.0, uClock * 0.004));
  vec3 color = mix(uDeepColor, uMidColor, 0.16 + 0.10 * smoothstep(-0.45, 0.55, sp.y));
  color *= 0.80 + 0.34 * plaster;

  float floorMask = smoothstep(-0.295, -0.315, sp.y);
  vec3 floorColour = uDeepColor * (0.45 + 0.25 * fbm(sp * vec2(2.2, 6.0)));
  color = mix(color, floorColour, floorMask);

  // The beam: a cone from the swinging lamp, filled with scrolling haze.
  float below = uLamp.y - sp.y;
  float halfWidth = 0.085 + 0.40 * max(below, 0.0) * (1.0 + 0.22 * uBeam);
  float cone = exp(-pow((sp.x - uLamp.x) / halfWidth, 2.0))
             * smoothstep(0.0, 0.05, below) * smoothstep(1.35, 0.30, below);
  vec2 smokeP = vec2((sp.x - uLamp.x) / (halfWidth + 0.02), below * 2.1);
  float s1 = fbm(smokeP * 1.6 + vec2(0.0, -uClock * 0.045));
  float s2 = fbm(smokeP * 3.1 + vec2(3.1, -uClock * 0.075) + 1.3 * s1);
  float smoke = smoothstep(0.22, 0.96, 0.45 * s1 + 0.75 * s2);
  float hazeLight = cone * (0.28 + 0.88 * smoke) * uHaze;

  color += uHighColor * hazeLight * (0.26 + 0.55 * uMid) * uGlowGain * 1.6;
  color += uMidColor * cone * 0.10 * uHaze * floorMask;   // pool of light on the floor

  // Dust and cigarette haze catching the light.
  vec2 moteCell = floor((sp + vec2(0.0, uClock * 0.014)) * 220.0);
  float mote = step(0.9974 - 0.0018 * uAir, hash(moteCell + fract(uClock * 2.0) * 0.017));
  color += uHighColor * mote * cone * (0.15 + 0.75 * uAir);

  // Lamp: cord, shade, and the one genuinely bright object on the panel.
  float cord = smoothstep(0.0038, 0.0, abs(sp.x - uLamp.x)) * step(uLamp.y, sp.y);
  color = mix(color, uDeepColor * 0.55, cord);
  float shade = 1.0 - smoothstep(0.9, 1.0, length((sp - vec2(uLamp.x, uLamp.y + 0.030)) * vec2(13.3, 31.0)));
  color = mix(color, mix(uDeepColor, uMidColor, 0.4), shade);
  float bulbD = length((sp - vec2(uLamp.x, uLamp.y - 0.012)) * vec2(1.0, 1.35));
  color += uHighColor * exp(-bulbD * bulbD * 240.0) * uFlicker * (0.45 + 0.55 * uGlowGain);

  // The trio. Silhouettes subtract light, so they are the safest pixels here.
  float dBass = bassSDF(sway(sp - vec2(-0.44, 0.0), 0.0));
  float dSax = saxSDF(sway(sp - vec2(0.06, 0.0), 2.1));
  float dKeys = pianistSDF(sway(sp - vec2(-0.20, -0.02), 4.0));
  float dFig = min(min(dBass, dSax), dKeys);
  float silhouette = (1.0 - smoothstep(0.0, 0.010, dFig)) * uPresence;
  float rim = smoothstep(0.038, 0.0, dFig) * (1.0 - silhouette) * hazeLight;

  float dFurn = furnitureSDF(sp, uPresence);
  float furniture = 1.0 - smoothstep(0.0, 0.010, dFurn);

  color *= 1.0 - 0.90 * max(silhouette, furniture);
  color += uHighColor * rim * 0.60 * uPresence;
  color += uHighColor * smoothstep(0.030, 0.0, dFurn) * (1.0 - furniture) * hazeLight * 0.30;

  // Candle on the front table: tiny, warm, and never steady.
  float flameR = 0.9 + 0.25 * uFlicker + 0.12 * sin(uClock * 11.0);
  float flame = 1.0 - smoothstep(0.0, 1.0, length((sp - vec2(0.02, -0.372)) * vec2(1.0, 0.55)) / (0.020 * flameR));
  color += mix(uHighColor, vec3(1.0, 0.62, 0.22), 0.35) * flame * (0.55 + 0.45 * uFlicker);
  color += uHighColor * exp(-length((sp - vec2(0.02, -0.375)) * vec2(3.2, 2.4)) * 2.2) * 0.10 * uFlicker;

  float vignette = smoothstep(1.30, 0.22, length(ndc - uCamera.xy * 0.5));
  color *= mix(1.0, vignette, 0.55);

  // Wear levelling, same discipline as the field scene.
  color = mix(color, color.brg, 0.06 + 0.07 * (0.5 + 0.5 * sin(uClock * 0.019)));
  color = clamp((color - 0.5) * uContrast + 0.5, 0.0, 1.0);

  // When the room is empty the lamp drops to an ember, but the haze keeps moving.
  float ceiling = max(0.05, uLift * uBreath * (1.0 - 0.55 * uIdle));
  color = ceiling * (1.0 - exp(-1.35 * color / ceiling));

  color += (hash(gl_FragCoord.xy + fract(uClock)) - 0.5) * uGrain;
  gl_FragColor = vec4(max(color, 0.0), 1.0);
}
`,

  /** @param {object} state frame state from main.js, including state.room */
  uniforms(state) {
    const room = state.room;
    return {
      uClock: state.clock,
      uSceneTime: state.sceneTime,
      uLift: state.lift,
      uBreath: state.breath,
      uIdle: state.idle,
      uGrain: state.grain,
      uContrast: state.contrast,
      uBass: state.bands.bass,
      uMid: state.bands.mid,
      uAir: state.bands.air,
      uPulse: state.pulse,
      uGlowGain: state.glowGain,
      uHaze: room.haze,
      uBeam: room.beam,
      uSway: room.swayPhase,
      uPresence: room.presence,
      uFlicker: room.flicker,
      uCamera: [room.camera.x, room.camera.y, room.camera.zoom],
      uLamp: [room.lamp.x, room.lamp.y],
      uDeepColor: state.colors[0],
      uMidColor: state.colors[1],
      uHighColor: state.colors[2],
    };
  },
};
