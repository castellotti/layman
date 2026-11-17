/**
 * The GL side of the Gibson 3D tab, kept thin: compile and link, buffers, textures and a `createScene` that holds
 * every GL object so that losing the context is one call to rebuild (as `matrix3d-gl.ts`). The component decides what
 * to draw and when; this owns the objects and the order of the passes. Colours arrive as floats from the scheme's
 * `Palette`, never literals. Data textures and instance buffers are written only when the city changes: a frame
 * uploads the camera, the clock, the arrivals and the cars.
 */
import { ATLAS_CELL, ATLAS_COLS, ATLAS_ROWS } from '../../lib/matrix-gpu.js';
import { MAX_CARS } from '../../lib/gibson-city.js';
import { PAGES_H, PAGES_W, TOWER_STRIDE, type Mat4, type Vec3 } from '../../lib/gibson-gpu.js';
import type { Palette } from '../../lib/gibson-schemes.js';
import { drawAtlas } from '../matrix/matrix3d-gl.js';
import {
  BOARD_FS, BOARD_VS, CAR_FS, CAR_VS, CHIP_FS, CHIP_VS, COMPOSITE, FLASH_FS, FLASH_VS, PAD_FS, PAD_VS, SKY, TOWER_FS, TOWER_VS, VERTEX,
} from './gibson3d-shaders.js';

/** Floats per car in the instance buffer: head x, z, direction x, z, colour r g b, flash. */
export const CAR_STRIDE = 8;
/** Arrivals the shader can show at once, as (tower index, start time) pairs. */
export const MAX_ARRIVALS = 16;
/** The board reaches this far past the city. */
export const BOARD_MARGIN = 96;
/** What is left of the picture at the corners. */
const CORNER_DARK = 0.75;
const CORNER_LIGHT = 0.93;

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
  let f: WebGLShader;
  try { f = compile(gl, gl.FRAGMENT_SHADER, fs, `${label} fragment shader`); } catch (e) { gl.deleteShader(v); throw e; }
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

/** The unit cube's 36 vertices, each a position (-0.5..0.5) and its face's normal, wound counter-clockwise from outside. */
function cubeVertices(): Float32Array {
  const out: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      const n = [0, 0, 0];
      n[axis] = sign;
      // a × b = the normal for the positive faces; the negative ones swap them.
      const a1 = [0, 0, 0];
      const b1 = [0, 0, 0];
      a1[(axis + 1) % 3] = 1;
      b1[(axis + 2) % 3] = 1;
      const [a, b] = sign > 0 ? [a1, b1] : [b1, a1];
      const at = (sa: number, sb: number): number[] => [0, 1, 2].map((i) => n[i] * 0.5 + a[i] * sa * 0.5 + b[i] * sb * 0.5);
      const v = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
      for (const i of [0, 1, 2, 0, 2, 3]) out.push(...v[i], ...n);
    }
  }
  return new Float32Array(out);
}

/** What one frame needs: the camera, the clock, the cars and the arrivals. */
export interface Frame {
  /** Seconds since the renderer was made: a float32 cannot hold `Date.now()`. 0 for a still frame. */
  time: number;
  viewProj: Mat4;
  /** The inverse of (projection × the view's rotation alone): the sky's view ray. */
  invSky: Mat4;
  eye: Vec3;
  /** `CAR_STRIDE` floats per car, the first `carCount` of them. */
  cars: Float32Array;
  carCount: number;
  /** (tower index, start time) pairs, the first `arrivalCount` of them. */
  arrivals: Float32Array;
  arrivalCount: number;
  /** The flash disc's colour (a refused car reaching its tower). */
  flash: [number, number, number];
}

export interface Scene {
  setPalette(p: Palette): void;
  setFont(font: string): void;
  /** `TOWER_STRIDE` floats per tower (`packTowers`), and the chips' (x, z) pairs. */
  setCity(towers: Float32Array, chips: Float32Array, half: number): void;
  setPages(data: Uint8Array): void;
  /** Backing size in device pixels. */
  resize(width: number, height: number): void;
  draw(frame: Frame): void;
  dispose(): void;
}

/** Everything the renderer owns, made from one context. */
export function createScene(gl: WebGL2RenderingContext): Scene {
  const programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  const textures: WebGLTexture[] = [];
  const frames: WebGLFramebuffer[] = [];
  const renderbuffers: WebGLRenderbuffer[] = [];
  const release = (): void => {
    programs.forEach((p) => gl.deleteProgram(p));
    buffers.forEach((b) => gl.deleteBuffer(b));
    vaos.forEach((v) => gl.deleteVertexArray(v));
    textures.forEach((t) => gl.deleteTexture(t));
    frames.forEach((f) => gl.deleteFramebuffer(f));
    renderbuffers.forEach((r) => gl.deleteRenderbuffer(r));
  };
  const make = <T>(thing: T | null, what: string): T => {
    if (!thing) throw new Error(`Gibson 3D: no ${what}`);
    return thing;
  };

  try {
    const prog = (vs: string, fs: string, label: string, names: string[]) => {
      const p = program(gl, vs, fs, `Gibson 3D ${label}`);
      programs.push(p);
      return { p, at: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])) as Record<string, WebGLUniformLocation | null> };
    };
    const sky = prog(VERTEX, SKY, 'sky', ['uInvVP', 'uTime', 'uLight', 'uBoard', 'uBase', 'uStrand', 'uArc', 'uFormula', 'uWash', 'uAtlas']);
    const board = prog(BOARD_VS, BOARD_FS, 'board', ['uVP', 'uHalf', 'uCam', 'uTime', 'uLight', 'uBoard', 'uTraceA', 'uTraceB']);
    const pad = prog(PAD_VS, PAD_FS, 'pads', ['uVP']);
    const chip = prog(CHIP_VS, CHIP_FS, 'chips', ['uVP', 'uBoard', 'uRim']);
    const tower = prog(TOWER_VS, TOWER_FS, 'towers', [
      'uVP', 'uTime', 'uArrN', 'uArr', 'uAtlas', 'uPages', 'uCam', 'uBlocked', 'uBoard', 'uLight', 'uMarks',
    ]);
    const car = prog(CAR_VS, CAR_FS, 'traffic', ['uVP', 'uLight']);
    const flash = prog(FLASH_VS, FLASH_FS, 'flashes', ['uVP', 'uFlash', 'uLight']);
    const composite = prog(VERTEX, COMPOSITE, 'composite', ['uScene', 'uBloom', 'uGain', 'uAspect', 'uCorner']);

    const buffer = (): WebGLBuffer => { const b = make(gl.createBuffer(), 'buffer'); buffers.push(b); return b; };
    const vao = (): WebGLVertexArrayObject => { const v = make(gl.createVertexArray(), 'vertex array'); vaos.push(v); return v; };
    const cube = buffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cube);
    gl.bufferData(gl.ARRAY_BUFFER, cubeVertices(), gl.STATIC_DRAW);
    const towerBuf = buffer();
    const chipBuf = buffer();
    const carBuf = buffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, carBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_CARS * CAR_STRIDE * 4, gl.DYNAMIC_DRAW);

    const bindCube = (): void => {
      gl.bindBuffer(gl.ARRAY_BUFFER, cube);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 3, gl.FLOAT, false, 24, 12);
    };
    const emptyVao = vao();
    const towerVao = vao();
    gl.bindVertexArray(towerVao);
    bindCube();
    gl.bindBuffer(gl.ARRAY_BUFFER, towerBuf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, TOWER_STRIDE * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    const chipVao = vao();
    gl.bindVertexArray(chipVao);
    bindCube();
    gl.bindBuffer(gl.ARRAY_BUFFER, chipBuf);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(6, 1);
    const carVao = vao();
    gl.bindVertexArray(carVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, carBuf);
    for (let i = 0; i < 2; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, CAR_STRIDE * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);

    const tex = (unit: number): WebGLTexture => {
      const t = make(gl.createTexture(), 'texture');
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
    const pages = tex(1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, PAGES_W, PAGES_H, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(PAGES_W * PAGES_H));
    const sceneT = tex(2);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const depth = make(gl.createRenderbuffer(), 'renderbuffer');
    renderbuffers.push(depth);
    const sceneFb = make(gl.createFramebuffer(), 'framebuffer');
    frames.push(sceneFb);
    let width = 1;
    let height = 1;
    const allocate = (): void => {
      gl.activeTexture(gl.TEXTURE0 + 2);
      gl.bindTexture(gl.TEXTURE_2D, sceneT);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    };
    allocate();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneT, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    // A target the driver cannot render to would leave the canvas blank with nothing to fall back on: fail now, so the tab offers Gibson 2D.
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Gibson 3D: render target incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    let palette: Palette | null = null;
    let towerCount = 0;
    let chipCount = 0;
    let half = 64;

    const rgb = (loc: WebGLUniformLocation | null, c: readonly number[]): void => gl.uniform3f(loc, c[0], c[1], c[2]);

    return {
      setPalette(p) { palette = p; },
      setFont(font) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, atlas);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ATLAS_COLS * ATLAS_CELL, ATLAS_ROWS * ATLAS_CELL, 0, gl.RED, gl.UNSIGNED_BYTE, drawAtlas(font));
        gl.generateMipmap(gl.TEXTURE_2D);
      },
      setCity(towers, chips, h) {
        towerCount = towers.length / TOWER_STRIDE;
        chipCount = chips.length / 2;
        half = h;
        gl.bindBuffer(gl.ARRAY_BUFFER, towerBuf);
        gl.bufferData(gl.ARRAY_BUFFER, towers, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, chipBuf);
        gl.bufferData(gl.ARRAY_BUFFER, chips, gl.DYNAMIC_DRAW);
      },
      setPages(data) {
        gl.activeTexture(gl.TEXTURE0 + 1);
        gl.bindTexture(gl.TEXTURE_2D, pages);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PAGES_W, PAGES_H, gl.RED, gl.UNSIGNED_BYTE, data);
      },
      resize(w, h) {
        const nw = Math.max(1, w);
        const nh = Math.max(1, h);
        if (nw === width && nh === height) return;
        width = nw;
        height = nh;
        allocate();
      },
      draw(f) {
        const pal = palette;
        if (!pal) return;
        const light = pal.light ? 1 : 0;
        const bg = pal.board;
        gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFb);
        gl.viewport(0, 0, width, height);
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.depthMask(true);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, atlas);

        // 1. The sky: behind everything, no depth.
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(sky.p);
        gl.bindVertexArray(emptyVao);
        gl.uniformMatrix4fv(sky.at.uInvVP, false, f.invSky);
        gl.uniform1f(sky.at.uTime, f.time);
        gl.uniform1f(sky.at.uLight, light);
        gl.uniform1i(sky.at.uAtlas, 0);
        rgb(sky.at.uBoard, bg);
        rgb(sky.at.uBase, pal.sky.base);
        rgb(sky.at.uStrand, pal.sky.strand);
        rgb(sky.at.uArc, pal.sky.arc);
        rgb(sky.at.uFormula, pal.sky.formula);
        rgb(sky.at.uWash, pal.sky.wash);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        // 2. The board.
        gl.useProgram(board.p);
        gl.uniformMatrix4fv(board.at.uVP, false, f.viewProj);
        gl.uniform1f(board.at.uHalf, half);
        gl.uniform3f(board.at.uCam, f.eye[0], f.eye[1], f.eye[2]);
        gl.uniform1f(board.at.uTime, f.time);
        gl.uniform1f(board.at.uLight, light);
        rgb(board.at.uBoard, bg);
        rgb(board.at.uTraceA, pal.traceA);
        rgb(board.at.uTraceB, pal.traceB);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // 3. The home chips: opaque, so before the light.
        if (chipCount > 0) {
          gl.useProgram(chip.p);
          gl.bindVertexArray(chipVao);
          gl.uniformMatrix4fv(chip.at.uVP, false, f.viewProj);
          rgb(chip.at.uBoard, bg);
          rgb(chip.at.uRim, pal.homeRim);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, chipCount);
        }

        if (towerCount > 0) {
          gl.depthMask(false);
          gl.enable(gl.BLEND);
          // 4. Tower pads: light on the board, which a light board has no use for.
          if (!pal.light) {
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(pad.p);
            gl.bindVertexArray(towerVao);
            gl.uniformMatrix4fv(pad.at.uVP, false, f.viewProj);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, towerCount);
          }
          // 5. The towers: additive, depth tested and not written, both sides of every face; on a light board, covering.
          if (pal.light) {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(true);
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
          } else {
            gl.blendFunc(gl.ONE, gl.ONE);
          }
          gl.useProgram(tower.p);
          gl.bindVertexArray(towerVao);
          gl.uniformMatrix4fv(tower.at.uVP, false, f.viewProj);
          gl.uniform1f(tower.at.uTime, f.time);
          gl.uniform1i(tower.at.uArrN, f.arrivalCount);
          if (f.arrivalCount > 0) gl.uniform2fv(tower.at.uArr, f.arrivals.subarray(0, f.arrivalCount * 2));
          gl.uniform1i(tower.at.uAtlas, 0);
          gl.uniform1i(tower.at.uPages, 1);
          gl.uniform3f(tower.at.uCam, f.eye[0], f.eye[1], f.eye[2]);
          rgb(tower.at.uBlocked, pal.glass.blocked);
          rgb(tower.at.uBoard, bg);
          gl.uniform1f(tower.at.uLight, light);
          gl.uniform1f(tower.at.uMarks, pal.marks ? 1 : 0);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, towerCount);
          gl.disable(gl.CULL_FACE);
          gl.depthMask(false);
        }

        // 6. The traffic.
        if (f.carCount > 0) {
          gl.enable(gl.BLEND);
          if (pal.light) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          else gl.blendFunc(gl.ONE, gl.ONE);
          gl.bindBuffer(gl.ARRAY_BUFFER, carBuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.cars.subarray(0, f.carCount * CAR_STRIDE));
          gl.bindVertexArray(carVao);
          gl.useProgram(car.p);
          gl.uniformMatrix4fv(car.at.uVP, false, f.viewProj);
          gl.uniform1f(car.at.uLight, light);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.carCount);
          gl.useProgram(flash.p);
          gl.uniformMatrix4fv(flash.at.uVP, false, f.viewProj);
          rgb(flash.at.uFlash, f.flash);
          gl.uniform1f(flash.at.uLight, light);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.carCount);
        }
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        gl.bindVertexArray(null);

        // The picture to the screen, under the vignette.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.DEPTH_TEST);
        gl.viewport(0, 0, width, height);
        gl.useProgram(composite.p);
        gl.bindVertexArray(emptyVao);
        gl.uniform1i(composite.at.uScene, 2);
        gl.uniform1i(composite.at.uBloom, 2);
        gl.uniform1f(composite.at.uGain, 0);
        gl.uniform1f(composite.at.uAspect, width / height);
        gl.uniform1f(composite.at.uCorner, pal.light ? CORNER_LIGHT : CORNER_DARK);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
      },
      dispose() {
        release();
        // The browser keeps only about 16 live contexts: give this one up now, not when the page is collected.
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}
