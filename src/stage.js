// The GL plumbing: one fullscreen triangle, a cache of fragment programs and a
// generic uniform setter. Scenes supply the shader source and a name→value map;
// nothing in here knows what anything looks like.

const VERTEX_SOURCE = `
attribute vec2 aCorner;
void main() { gl_Position = vec4(aCorner, 0.0, 1.0); }
`;

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

/** name → { location, type }, so a scene's uniform map can be applied blind. */
function describeUniforms(gl, program) {
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  const described = new Map();
  for (let index = 0; index < count; index++) {
    const info = gl.getActiveUniform(program, index);
    described.set(info.name.replace(/\[0\]$/, ''), {
      location: gl.getUniformLocation(program, info.name),
      type: info.type,
    });
  }
  return described;
}

export class Stage {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl', {
      antialias: false,
      depth: false,
      alpha: false,
      powerPreference: 'high-performance',
    }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable — enable hardware acceleration in Brave');

    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.gl = gl;
    this.canvas = canvas;
    this.vertexBuffer = vertexBuffer;
    this.programs = new Map();
    this.scene = null;
    this.renderScale = 1;
    this.backingPixels = 0;
  }

  /** Compile once per scene, then just swap programs. */
  programFor(scene) {
    let program = this.programs.get(scene.id);
    if (program) return program;

    const { gl } = this;
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, scene.fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`${scene.id}: program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    program.uniforms = describeUniforms(gl, program);
    program.warned = new Set();
    program.cornerLocation = gl.getAttribLocation(program, 'aCorner');
    gl.enableVertexAttribArray(program.cornerLocation);
    this.programs.set(scene.id, program);
    return program;
  }

  /** @param {{id: string, label: string, fragment: string, uniforms: Function}} scene */
  setScene(scene) {
    this.scene = scene;
    const program = this.programFor(scene);
    const { gl } = this;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.vertexAttribPointer(program.cornerLocation, 2, gl.FLOAT, false, 0, 0);
    this.resize();
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
  }

  /** @param {object} state whatever the active scene's uniforms() mapper expects */
  render(state) {
    const { gl } = this;
    const scene = this.scene;
    const program = this.programFor(scene);
    const values = scene.uniforms(state);
    values.uRes = [this.canvas.width, this.canvas.height];

    for (const [name, value] of Object.entries(values)) {
      const target = program.uniforms.get(name);
      if (!target) {
        // A value with no matching uniform is almost always a typo in a scene,
        // and it fails as "that feature quietly does nothing".
        if (!program.warned.has(name)) {
          program.warned.add(name);
          console.warn(`${scene.id}: no such uniform ${name}`);
        }
        continue;
      }
      switch (target.type) {
        case gl.FLOAT: gl.uniform1f(target.location, value); break;
        case gl.FLOAT_VEC2: gl.uniform2f(target.location, value[0], value[1]); break;
        case gl.FLOAT_VEC3: gl.uniform3f(target.location, value[0], value[1], value[2]); break;
        case gl.FLOAT_VEC4: gl.uniform4f(target.location, value[0], value[1], value[2], value[3]); break;
        default: console.warn(`${scene.id}: unsupported uniform type for ${name}`);
      }
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
