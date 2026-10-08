// Minimal WebGL1 point-cloud renderer: perspective-scaled round splats, a world-space
// classification sweep, a screen-space before/after split, and vector feature overlays.

import { CLASS_COLORS, type Scene } from './scenes';

const POINT_VS = `
attribute vec3 aPos;
attribute vec2 aAttr;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec3 uPalette[${CLASS_COLORS.length}];
uniform vec3 uBg;
uniform vec3 uAccent;
uniform float uSize;
uniform float uPxScale;
uniform float uSweep;
uniform float uFade;
uniform float uCompare;
uniform float uSplit;
uniform vec2 uFog;
varying vec3 vColor;

void main() {
  vec4 mv = uView * vec4(aPos, 1.0);
  gl_Position = uProj * mv;
  float depth = -mv.z;

  vec3 raw = mix(vec3(0.10, 0.12, 0.13), vec3(0.90, 0.95, 0.96), aAttr.y);
  vec3 cls = uPalette[int(aAttr.x + 0.5)] * (0.72 + 0.4 * aAttr.y);

  float k;
  float glow = 0.0;
  if (uCompare > 0.5) {
    k = step(uSplit, gl_Position.x / gl_Position.w);
  } else {
    k = smoothstep(uSweep + 0.6, uSweep - 0.6, aPos.x) * uFade;
    float d = (aPos.x - uSweep) / 1.6;
    glow = exp(-d * d) * uFade;
  }

  vec3 c = mix(raw, cls, k) + uAccent * glow * 0.9;
  float fog = smoothstep(uFog.x, uFog.y, depth);
  vColor = mix(c, uBg, fog * 0.85);
  gl_PointSize = clamp(uSize * uPxScale / depth, 1.0, 7.0);
}`;

const POINT_FS = `
precision mediump float;
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColor * (1.0 - 0.22 * r), 1.0);
}`;

const LINE_VS = `
attribute vec3 aPos;
attribute vec2 aAttr;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec3 uPalette[${CLASS_COLORS.length}];
uniform float uSweep;
uniform float uFade;
uniform mediump float uCompare; // shared with the fragment shader, so precisions must match
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_Position = uProj * uView * vec4(aPos, 1.0);
  vColor = mix(uPalette[int(aAttr.x + 0.5)], vec3(1.0), 0.25);
  vAlpha = uCompare > 0.5 ? 1.0 : smoothstep(aAttr.y, aAttr.y + 6.0, uSweep) * uFade;
}`;

const LINE_FS = `
precision mediump float;
uniform float uCompare;
uniform float uSplitPx;
uniform float uAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a = vAlpha * uAlpha;
  if (uCompare > 0.5 && gl_FragCoord.x < uSplitPx) discard;
  gl_FragColor = vec4(vColor, a);
}`;

type Mat4 = Float32Array;

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function lookAt(eye: number[], target: number[]): Mat4 {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  zx /= len; zy /= len; zz /= len;
  let xx = zz;
  let xy = 0;
  let xz = -zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, vs: string, fs: string) {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  return {
    prog,
    aPos: gl.getAttribLocation(prog, 'aPos'),
    aAttr: gl.getAttribLocation(prog, 'aAttr'),
    u(name: string) {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(prog, name));
      return uniforms.get(name)!;
    },
  };
}

export interface ViewOptions {
  mode: 'sweep' | 'compare';
  autoRotate?: boolean;
  pointSize?: number;
  onTick?: (time: number, view: PointCloudView) => void;
}

export class PointCloudView {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGLRenderingContext;
  scene: Scene | null = null;

  azimuth = 0;
  elevation = 0.5;
  radius = 160;
  target = [0, 0, 0];
  sweep = -1e4;
  fade = 1;
  split = 0.5; // 0..1 across the canvas, compare mode
  lineAlpha = 0.7;

  private opts: ViewOptions;
  private pointProg: ReturnType<typeof compile>;
  private lineProg: ReturnType<typeof compile>;
  private buffers: { pos: WebGLBuffer; attr: WebGLBuffer; lines: WebGLBuffer } | null = null;
  private palette: Float32Array;
  private running = false;
  private visible = false;
  private raf = 0;
  private last = 0;
  private dragging = false;
  private idleUntil = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private cleanup: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, opts: ViewOptions) {
    this.canvas = canvas;
    this.opts = opts;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.pointProg = compile(gl, POINT_VS, POINT_FS);
    this.lineProg = compile(gl, LINE_VS, LINE_FS);
    this.palette = new Float32Array(CLASS_COLORS.flatMap(hexToRgb));

    gl.clearColor(0.043, 0.047, 0.047, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.updateLoop();
    });
    io.observe(canvas);
    const onVis = () => this.updateLoop();
    document.addEventListener('visibilitychange', onVis);
    this.cleanup.push(() => ro.disconnect(), () => io.disconnect(), () => document.removeEventListener('visibilitychange', onVis));
    this.bindDrag();
    this.resize();
  }

  setScene(scene: Scene) {
    const gl = this.gl;
    if (this.buffers) {
      gl.deleteBuffer(this.buffers.pos);
      gl.deleteBuffer(this.buffers.attr);
      gl.deleteBuffer(this.buffers.lines);
    }
    const make = (data: Float32Array) => {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return buf;
    };
    this.buffers = { pos: make(scene.positions), attr: make(scene.attrs), lines: make(scene.lines) };
    this.scene = scene;
    this.radius = scene.camera.radius;
    this.elevation = scene.camera.elevation;
    this.azimuth = scene.camera.azimuth;
    this.target = [...scene.camera.target];
    this.render(performance.now());
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
  }

  /** Render a single frame now, e.g. after changing the split while paused. */
  draw() {
    if (!this.running) this.render(performance.now());
  }

  private updateLoop() {
    const should = this.visible && !document.hidden;
    if (should && !this.running) {
      this.running = true;
      this.last = performance.now();
      const loop = (t: number) => {
        if (!this.running) return;
        this.render(t);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    } else if (!should && this.running) {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.draw();
    }
  }

  private bindDrag() {
    const c = this.canvas;
    let px = 0;
    let py = 0;
    const down = (e: PointerEvent) => {
      this.dragging = true;
      px = e.clientX;
      py = e.clientY;
      c.setPointerCapture(e.pointerId);
      c.classList.add('is-dragging');
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.azimuth -= (e.clientX - px) * 0.006;
      this.elevation = Math.min(1.35, Math.max(0.12, this.elevation + (e.clientY - py) * 0.004));
      px = e.clientX;
      py = e.clientY;
      this.draw();
    };
    const up = () => {
      this.dragging = false;
      this.idleUntil = performance.now() + 2500;
      c.classList.remove('is-dragging');
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  private render(t: number) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.opts.onTick?.(t, this);
    if (this.opts.autoRotate !== false && !this.reducedMotion && !this.dragging && t > this.idleUntil) {
      this.azimuth += dt * 0.045;
    }

    const gl = this.gl;
    const scene = this.scene;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!scene || !this.buffers) return;

    const aspect = this.canvas.width / this.canvas.height;
    const fov = 0.62;
    // Pull back on narrow viewports so the scene still fits horizontally.
    const radius = this.radius * Math.max(1, 1.45 / aspect);
    const eye = [
      this.target[0] + radius * Math.cos(this.elevation) * Math.sin(this.azimuth),
      this.target[1] + radius * Math.sin(this.elevation),
      this.target[2] + radius * Math.cos(this.elevation) * Math.cos(this.azimuth),
    ];
    const proj = perspective(fov, aspect, 1, radius * 4);
    const view = lookAt(eye, this.target);
    const compare = this.opts.mode === 'compare' ? 1 : 0;

    // Points
    const p = this.pointProg;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.u('uProj'), false, proj);
    gl.uniformMatrix4fv(p.u('uView'), false, view);
    gl.uniform3fv(p.u('uPalette'), this.palette);
    gl.uniform3f(p.u('uBg'), 0.043, 0.047, 0.047);
    gl.uniform3f(p.u('uAccent'), 0.24, 0.96, 0.77);
    gl.uniform1f(p.u('uSize'), (this.opts.pointSize ?? 0.4) * (scene.pointScale ?? 1));
    gl.uniform1f(p.u('uPxScale'), this.canvas.height / (2 * Math.tan(fov / 2)));
    gl.uniform1f(p.u('uSweep'), this.sweep);
    gl.uniform1f(p.u('uFade'), this.fade);
    gl.uniform1f(p.u('uCompare'), compare);
    gl.uniform1f(p.u('uSplit'), this.split * 2 - 1);
    gl.uniform2f(p.u('uFog'), radius * 0.55, radius * 1.9);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.pos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.attr);
    gl.enableVertexAttribArray(p.aAttr);
    gl.vertexAttribPointer(p.aAttr, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, scene.count);

    // Vector features, drawn x-ray style over the points.
    if (scene.lineVerts) {
      const l = this.lineProg;
      gl.useProgram(l.prog);
      gl.uniformMatrix4fv(l.u('uProj'), false, proj);
      gl.uniformMatrix4fv(l.u('uView'), false, view);
      gl.uniform3fv(l.u('uPalette'), this.palette);
      gl.uniform1f(l.u('uSweep'), this.sweep);
      gl.uniform1f(l.u('uFade'), this.fade);
      gl.uniform1f(l.u('uCompare'), compare);
      gl.uniform1f(l.u('uSplitPx'), this.split * this.canvas.width);
      gl.uniform1f(l.u('uAlpha'), this.lineAlpha);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.lines);
      gl.enableVertexAttribArray(l.aPos);
      gl.vertexAttribPointer(l.aPos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(l.aAttr);
      gl.vertexAttribPointer(l.aAttr, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.LINES, 0, scene.lineVerts);
    }
  }
}
