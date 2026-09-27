// The original scene: a domain-warped fBm field coloured by the mood palette.
// Everything that moves is a function of time and audio, which is what makes the
// burn-in defence reliable — there is no asset with a fixed screen position.

export const fieldScene = {
  id: 'field',
  label: 'Mood field',
  fragment: `
precision highp float;

uniform vec2  uRes;
uniform float uSceneTime;   // scaled by mood flow, so slow moods really are slow
uniform float uClock;       // wall clock: drift, breathing, dither
uniform vec2  uDrift;       // -1..1 whole-field pan, the main burn-in defence
uniform vec2  uGlow;        // slow-moving light source
uniform float uLift;        // luminance ceiling in 0..1
uniform float uBreath;      // slow ceiling modulation around 1
uniform float uIdle;        // 0..1 no-signal fade
uniform float uGrain;
uniform float uContrast;
uniform float uFlow;
uniform float uTurbulence;
uniform float uPulseGain;
uniform float uGlowGain;
uniform float uBass;
uniform float uMid;
uniform float uAir;
uniform float uPulse;
uniform vec3  uDeepColor;
uniform vec3  uMidColor;
uniform vec3  uHighColor;

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

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  uv += uDrift * 0.045;

  float t = uSceneTime;
  vec2 flow = vec2(t * 0.05, -t * 0.038) * (0.6 + uFlow * 3.0);
  vec2 p = uv * (2.0 + uBass * 1.4);

  vec2 q = vec2(fbm(p * 1.30 + flow), fbm(p * 1.30 + vec2(5.2, 1.3) - flow.yx));
  vec2 r = vec2(fbm(p * 1.55 + 1.7 * q + vec2(1.7, 9.2) + flow * 1.5),
                fbm(p * 1.55 + 1.7 * q + vec2(8.3, 2.8) - flow * 1.3));
  float f = fbm(p * 1.85 + (0.55 + uTurbulence * 1.5) * r);

  float shape = clamp(f * 1.28 - 0.10 + 0.20 * length(q), 0.0, 1.0);
  vec3 color = mix(uDeepColor, uMidColor, smoothstep(0.14, 0.74, shape));
  color = mix(color, uHighColor, pow(smoothstep(0.58, 1.0, shape), 1.5) * (0.35 + 0.5 * uMid));

  float distanceToGlow = length((uv - uGlow) * vec2(1.0, 1.18));
  float glow = uGlowGain * (0.10 + 0.26 * uPulseGain * uPulse + 0.20 * uBass)
             * exp(-2.4 * distanceToGlow * distanceToGlow);
  color += mix(uHighColor, uMidColor, 0.35) * glow;

  float ridge = 1.0 - abs(f * 2.0 - 1.0);
  color += uHighColor * pow(ridge, 5.0) * (0.10 + 0.30 * uAir + 0.24 * uPulseGain * uPulse);

  vec2 sparkleCell = floor((uv + uDrift * 0.05) * 260.0);
  float sparkle = hash(sparkleCell + fract(uClock) * 0.013);
  color += uHighColor * step(0.9982 - 0.0015 * uAir, sparkle) * (0.10 + 0.55 * uAir);

  float vignette = smoothstep(1.45, 0.20, length(uv - uGlow * 0.45));
  color *= mix(1.0, vignette, 0.5);

  // Wear levelling: even when the music sits in one palette for an hour, the
  // hues keep sliding across the panel instead of ageing the same subpixels.
  color = mix(color, color.brg, 0.06 + 0.07 * (0.5 + 0.5 * sin(uClock * 0.019)));

  color = clamp((color - 0.5) * uContrast + 0.5, 0.0, 1.0);

  // Soft-rolled ceiling: no channel ever sits at panel maximum, which is what
  // protects an OLED far more than any amount of motion does.
  float ceiling = max(0.05, uLift * uBreath * (1.0 - 0.62 * uIdle));
  color = ceiling * (1.0 - exp(-1.35 * color / ceiling));

  color += (hash(gl_FragCoord.xy + fract(uClock)) - 0.5) * uGrain;
  gl_FragColor = vec4(max(color, 0.0), 1.0);
}
`,

  /** @param {object} state the frame state assembled by main.js */
  uniforms(state) {
    return {
      uSceneTime: state.sceneTime,
      uClock: state.clock,
      uDrift: [state.drift.x, state.drift.y],
      uGlow: [state.glow.x, state.glow.y],
      uLift: state.lift,
      uBreath: state.breath,
      uIdle: state.idle,
      uGrain: state.grain,
      uContrast: state.contrast,
      uFlow: state.flow,
      uTurbulence: state.turbulence,
      uPulseGain: state.pulseGain,
      uGlowGain: state.glowGain,
      uBass: state.bands.bass,
      uMid: state.bands.mid,
      uAir: state.bands.air,
      uPulse: state.pulse,
      uDeepColor: state.colors[0],
      uMidColor: state.colors[1],
      uHighColor: state.colors[2],
    };
  },
};
