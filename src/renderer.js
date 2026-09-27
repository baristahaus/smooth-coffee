// WebGL1 fullscreen field renderer. One triangle, one fragment shader, no
// geometry, no textures: everything that moves is a function of time and audio,
// which is also what makes the burn-in defence reliable — there is no asset with
// a fixed screen position to wear in.

const VERTEX_SOURCE = `
attribute vec2 aCorner;
void main() { gl_Position = vec4(aCorner, 0.0, 1.0); }
`;

const FRAGMENT_SOURCE = `
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
`;

const UNIFORM_NAMES = [
  'uRes', 'uSceneTime', 'uClock', 'uDrift', 'uGlow', 'uLift', 'uBreath', 'uIdle',
  'uGrain', 'uContrast', 'uFlow', 'uTurbulence', 'uPulseGain', 'uGlowGain',
  'uBass', 'uMid', 'uAir', 'uPulse',
  'uDeepColor', 'uMidColor', 'uHighColor',
];

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl', {
      antialias: false,
      depth: false,
      alpha: false,
      powerPreference: 'high-performance',
    }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable — enable hardware acceleration in Brave');

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const cornerLocation = gl.getAttribLocation(program, 'aCorner');
    gl.enableVertexAttribArray(cornerLocation);
    gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, 0, 0);

    this.gl = gl;
    this.canvas = canvas;
    this.uniform = Object.fromEntries(
      UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    this.renderScale = 1;
    this.backingPixels = 0;
  }

  /** @param {number} scale multiplier on CSS size for the drawing buffer */
  setRenderScale(scale) {
    if (scale === this.renderScale) return;
    this.renderScale = scale;
    this.resize();
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetWidth = Math.max(1, Math.round(width * dpr * this.renderScale));
    const targetHeight = Math.max(1, Math.round(height * dpr * this.renderScale));
    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    this.backingPixels = targetWidth * targetHeight;
    this.gl.viewport(0, 0, targetWidth, targetHeight);
    this.gl.uniform2f(this.uniform.uRes, targetWidth, targetHeight);
  }

  /** @param {object} scene assembled each frame by main.js */
  render(scene) {
    const { gl, uniform } = this;
    gl.uniform1f(uniform.uSceneTime, scene.sceneTime);
    gl.uniform1f(uniform.uClock, scene.clock);
    gl.uniform2f(uniform.uDrift, scene.drift.x, scene.drift.y);
    gl.uniform2f(uniform.uGlow, scene.glow.x, scene.glow.y);
    gl.uniform1f(uniform.uLift, scene.lift);
    gl.uniform1f(uniform.uBreath, scene.breath);
    gl.uniform1f(uniform.uIdle, scene.idle);
    gl.uniform1f(uniform.uGrain, scene.grain);
    gl.uniform1f(uniform.uContrast, scene.contrast);
    gl.uniform1f(uniform.uFlow, scene.flow);
    gl.uniform1f(uniform.uTurbulence, scene.turbulence);
    gl.uniform1f(uniform.uPulseGain, scene.pulseGain);
    gl.uniform1f(uniform.uGlowGain, scene.glowGain);
    gl.uniform1f(uniform.uBass, scene.bands.bass);
    gl.uniform1f(uniform.uMid, scene.bands.mid);
    gl.uniform1f(uniform.uAir, scene.bands.air);
    gl.uniform1f(uniform.uPulse, scene.pulse);
    gl.uniform3fv(uniform.uDeepColor, scene.colors[0]);
    gl.uniform3fv(uniform.uMidColor, scene.colors[1]);
    gl.uniform3fv(uniform.uHighColor, scene.colors[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
