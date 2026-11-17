/**
 * The GL side of the Matrix 3D tab, kept thin: compile and link, textures, and a `createScene` that holds
 * every GL object so that losing the context is one call to rebuild. The component decides what to draw
 * and when; this only owns the objects. Colours arrive as floats (from theme tokens), never literals.
 */
import {
  ATLAS_CELL, ATLAS_COLS, ATLAS_ROWS, COLS, GLYPHS, LAYERS, TEXT_LEN, gridUniform,
} from '../../lib/matrix-gpu.js';
import { BLUR, BRIGHT, COMPOSITE, VERTEX, sceneFragment } from './matrix3d-shaders.js';

export type Rgb = [number, number, number];

export interface SceneColours {
  bg: Rgb; rain: Rgb; head: Rgb; fresh: Rgb; blocked: Rgb; untunnelled: Rgb;
  /** The background is light: draw by cover, not by addition. */
  light: boolean;
}

/** Throws the compile or link log with the offending source's line numbers: the first load says everything. */
function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`${label}: createShader failed`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
    throw new Error(`${label} failed to compile:\n${log}\n${numbered}`);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string, label: string): WebGLProgram {
  const v = compile(gl, gl.VERTEX_SHADER, vs, `${label} vertex shader`);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs, `${label} fragment shader`);
  const p = gl.createProgram();
  if (!p) throw new Error(`${label}: createProgram failed`);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) ?? '';
    gl.deleteProgram(p);
    throw new Error(`${label} failed to link:\n${log}`);
  }
  return p;
}

/** The glyph atlas as a single channel, white on black: a 16 × 8 grid of 64 px cells, bold, centred. */
export function drawAtlas(font: string): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * ATLAS_CELL;
  canvas.height = ATLAS_ROWS * ATLAS_CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D context for the glyph atlas');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'white';
  ctx.font = `bold ${Math.round(ATLAS_CELL * 0.78)}px ${font || 'monospace'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  GLYPHS.forEach((g, i) => {
    if (i === 0) return;
    ctx.fillText(g, (i % ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2, Math.floor(i / ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL / 2 + 2);
  });
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return out;
}

export interface Scene {
  setColours(c: SceneColours): void;
  setFont(font: string): void;
  setColumns(data: Float32Array): void;
  setText(data: Uint8Array): void;
  /** Backing size in device pixels. */
  resize(width: number, height: number): void;
  draw(timeSeconds: number): void;
  destroy(): void;
}

const BLOOM_THRESHOLD = 0.6;
const BLOOM_GAIN = 0.9;
/** What is left of the picture at the corners. */
const CORNER_DARK = 0.75;
const CORNER_LIGHT = 0.93;

/** Everything the renderer owns, made from one context. `firstLayer`: the nearest layers drawn are firstLayer..LAYERS-1. */
export function createScene(gl: WebGL2RenderingContext, firstLayer: number): Scene {
  const prog = program(gl, VERTEX, sceneFragment(firstLayer), 'Matrix 3D scene');
  const u = (name: string) => gl.getUniformLocation(prog, name);
  const loc = {
    time: u('uTime'), aspect: u('uAspect'), light: u('uLight'), atlas: u('uAtlas'), columns: u('uColumns'), text: u('uText'),
    grid: u('uGrid'), bg: u('uBg'), rain: u('uRain'), head: u('uHead'), fresh: u('uFresh'), blocked: u('uBlocked'), untunnelled: u('uUntunnelled'),
  };
  const textures: WebGLTexture[] = [];
  const frames: WebGLFramebuffer[] = [];
  const programs: WebGLProgram[] = [prog];
  const vao = gl.createVertexArray();
  const release = () => {
    programs.forEach((p) => gl.deleteProgram(p));
    textures.forEach((t) => gl.deleteTexture(t));
    frames.forEach((f) => gl.deleteFramebuffer(f));
    if (vao) gl.deleteVertexArray(vao);
  };
  if (!vao) { release(); throw new Error('Matrix 3D: no vertex array'); }
  const tex = (unit: number) => {
    const t = gl.createTexture();
    if (!t) { release(); throw new Error('Matrix 3D: no texture'); }
    textures.push(t);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const atlas = tex(0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const columns = tex(1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, COLS, LAYERS, 0, gl.RGBA, gl.FLOAT, new Float32Array(COLS * LAYERS * 4));
  const text = tex(2);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, TEXT_LEN, COLS * LAYERS, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(TEXT_LEN * COLS * LAYERS));

  // The passes after the scene: bright pass and two blurs at half size, then the composite to the screen.
  const post = (fs: string, label: string, names: string[]) => {
    let p: WebGLProgram;
    try { p = program(gl, VERTEX, fs, label); } catch (e) { release(); throw e; }
    programs.push(p);
    return { p, at: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])) as Record<string, WebGLUniformLocation | null> };
  };
  const bright = post(BRIGHT, 'Matrix 3D bright pass', ['uScene', 'uThreshold']);
  const blur = post(BLUR, 'Matrix 3D blur', ['uSrc', 'uDir']);
  const composite = post(COMPOSITE, 'Matrix 3D composite', ['uScene', 'uBloom', 'uGain', 'uAspect', 'uCorner']);

  interface Target { tex: WebGLTexture; fb: WebGLFramebuffer }
  const target = (unit: number): Target => {
    const t = tex(unit);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer();
    if (!fb) { release(); throw new Error('Matrix 3D: no framebuffer'); }
    frames.push(fb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { tex: t, fb };
  };
  const sceneT = target(3);
  const bloomA = target(4);
  const bloomB = target(5);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const allocate = (t: Target, unit: number, w: number, h: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  };

  let colours: SceneColours | null = null;
  let width = 1;
  let height = 1;
  allocate(sceneT, 3, 1, 1);
  allocate(bloomA, 4, 1, 1);
  allocate(bloomB, 5, 1, 1);

  return {
    setColours(c) { colours = c; },
    setFont(font) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ATLAS_COLS * ATLAS_CELL, ATLAS_ROWS * ATLAS_CELL, 0, gl.RED, gl.UNSIGNED_BYTE, drawAtlas(font));
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    setColumns(data) {
      gl.activeTexture(gl.TEXTURE0 + 1);
      gl.bindTexture(gl.TEXTURE_2D, columns);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, COLS, LAYERS, gl.RGBA, gl.FLOAT, data);
    },
    setText(data) {
      gl.activeTexture(gl.TEXTURE0 + 2);
      gl.bindTexture(gl.TEXTURE_2D, text);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXT_LEN, COLS * LAYERS, gl.RED, gl.UNSIGNED_BYTE, data);
    },
    resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      allocate(sceneT, 3, width, height);
      allocate(bloomA, 4, Math.max(1, width >> 1), Math.max(1, height >> 1));
      allocate(bloomB, 5, Math.max(1, width >> 1), Math.max(1, height >> 1));
    },
    draw(t) {
      if (!colours) return;
      const hw = Math.max(1, width >> 1);
      const hh = Math.max(1, height >> 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneT.fb);
      gl.viewport(0, 0, width, height);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1f(loc.time, t);
      gl.uniform1f(loc.aspect, width / height);
      gl.uniform1f(loc.light, colours.light ? 1 : 0);
      gl.uniform1i(loc.atlas, 0);
      gl.uniform1i(loc.columns, 1);
      gl.uniform1i(loc.text, 2);
      gl.uniform3fv(loc.grid, gridUniform(width / height));
      gl.uniform3fv(loc.bg, colours.bg);
      gl.uniform3fv(loc.rain, colours.rain);
      gl.uniform3fv(loc.head, colours.head);
      gl.uniform3fv(loc.fresh, colours.fresh);
      gl.uniform3fv(loc.blocked, colours.blocked);
      gl.uniform3fv(loc.untunnelled, colours.untunnelled);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Glow: only on a dark background, where light adds to the picture.
      const glow = !colours.light;
      if (glow) {
        gl.viewport(0, 0, hw, hh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
        gl.useProgram(bright.p);
        gl.uniform1i(bright.at.uScene, 3);
        gl.uniform1f(bright.at.uThreshold, BLOOM_THRESHOLD);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.useProgram(blur.p);
        gl.uniform1i(blur.at.uSrc, 4);
        gl.uniform2f(blur.at.uDir, 1 / hw, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fb);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.uniform1i(blur.at.uSrc, 5);
        gl.uniform2f(blur.at.uDir, 0, 1 / hh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.useProgram(composite.p);
      gl.uniform1i(composite.at.uScene, 3);
      gl.uniform1i(composite.at.uBloom, 4);
      gl.uniform1f(composite.at.uGain, glow ? BLOOM_GAIN : 0);
      gl.uniform1f(composite.at.uAspect, width / height);
      gl.uniform1f(composite.at.uCorner, glow ? CORNER_DARK : CORNER_LIGHT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      release();
      // The browser keeps only about 16 live contexts: give this one up now, not when the page is collected.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
