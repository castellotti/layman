/**
 * GLSL for the Matrix 3D tab, as source strings. Written from the description in the project's own design
 * notes, not from any styx-godot shader (docs/extensions/styx.md → Licences).
 *
 * No colour literal: every colour arrives as a uniform read from a theme token (`readToken`). Only `vec3(0.0)`
 * and `vec3(1.0)` appear. The layer table, grid constants and layer transform come from `lib/matrix-gpu.ts`
 * (`layerCell` there and the transform below are one rule in two copies: change both or neither).
 */
import { ATLAS_COLS, ATLAS_ROWS, CELL_W, COLS, DRIFT_RATE, LAYERS, LAYER_SPECS, ROWS, TEXT_LEN } from '../../lib/matrix-gpu.js';

export const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  // One triangle that covers the screen; vUv is 0..1 with y down.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
const floats = (name: string, pick: (i: number) => number) =>
  `const float ${name}[${LAYERS}] = float[${LAYERS}](${Array.from({ length: LAYERS }, (_, i) => f(pick(i))).join(', ')});`;

/** `firstLayer`: the nearest layers drawn are firstLayer..LAYERS-1. */
export function sceneFragment(firstLayer: number): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

#define LAYERS ${LAYERS}
#define FIRST_LAYER ${firstLayer}
#define COLS ${COLS}
#define TEXT_LEN ${TEXT_LEN}
#define ROWS ${f(ROWS)}
#define CELL_W ${CELL_W}
#define DRIFT_RATE ${f(DRIFT_RATE)}
#define ATLAS ${'vec2(' + f(ATLAS_COLS) + ', ' + f(ATLAS_ROWS) + ')'}

${floats('SCALE', (i) => LAYER_SPECS[i].scale)}
${floats('SPEED', (i) => LAYER_SPECS[i].speed)}
${floats('DIM', (i) => LAYER_SPECS[i].dim)}
${floats('DRIFT', (i) => LAYER_SPECS[i].drift)}

in vec2 vUv;
out vec4 outColor;

uniform float uTime;
uniform float uAspect;
uniform float uLight;        // 1 on a light background: cover instead of add
uniform sampler2D uAtlas;    // R8, mipmapped
uniform sampler2D uColumns;  // RGBA32F, COLS x LAYERS: start, speed, length, tone/fresh/weight
uniform sampler2D uText;     // R8, TEXT_LEN x (COLS * LAYERS): glyph indices
uniform vec3 uGrid[LAYERS];  // per layer: visible columns, data columns, first data column
uniform vec3 uBg;
uniform vec3 uRain;          // filler, and a normal stream's body
uniform vec3 uHead;          // a stream's head
uniform vec3 uFresh;
uniform vec3 uBlocked;
uniform vec3 uUntunnelled;

// PCG, an integer hash: stable for a cell however large the time grows.
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float hash(int a, int b, int c) {
  return float(pcg(pcg(pcg(uint(a)) + uint(b)) + uint(c))) / 4294967295.0;
}

void main() {
  vec3 col = uLight > 0.5 ? uBg : vec3(0.0);
  for (int layer = FIRST_LAYER; layer < LAYERS; layer++) {
    // This is the transform lib/matrix-gpu.ts layerCell() mirrors.
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    p.x += DRIFT[layer] * sin(uTime * DRIFT_RATE);
    p *= SCALE[layer];
    vec3 g = uGrid[layer];
    float rows = ROWS * SCALE[layer];
    vec2 cell = vec2(p.x / CELL_W + g.x * 0.5, p.y * ROWS + rows * 0.5);
    // Derivatives of the cell coordinate, taken before any branch: the atlas is sampled with them, so a
    // glyph never takes its mip level from a neighbouring cell's glyph.
    vec2 dx = dFdx(cell) / ATLAS;
    vec2 dy = dFdy(cell) / ATLAS;

    if (cell.x < 0.0 || cell.x >= g.x || cell.y < 0.0) continue;
    int gc = int(floor(cell.x));
    float row = floor(cell.y);
    vec2 fr = fract(cell);
    int dc = gc - int(g.z);

    int glyph = 0;
    bool live = false;   // inside a stream: a character the atlas lacks stays blank, never filler
    float bright = 0.0;
    vec3 tint = uRain;

    if (dc >= 0 && dc < int(g.y)) {
      vec4 c = texelFetch(uColumns, ivec2(dc, layer), 0);
      float len = c.b;
      float d = (uTime - c.r) * c.g * SPEED[layer] - row;   // rows behind the head; below 0: not reached yet
      if (len > 0.5 && d >= 0.0 && d < len) {
        live = true;
        float ai = floor(c.a);
        float tone = mod(ai, 4.0);
        bool fresh = ai >= 4.0;
        float weight = 2.0 * (c.a - ai);
        int idx = int(len) - 1 - int(floor(d));
        glyph = int(texelFetch(uText, ivec2(idx, layer * COLS + dc), 0).r * 255.0 + 0.5);
        bright = mix(0.55, 1.0, weight) * (1.0 - 0.6 * d / len);
        tint = tone > 1.5 ? uUntunnelled : (tone > 0.5 ? uBlocked : uRain);
        if (fresh && d < 7.0) tint = uFresh;
        if (d < 1.0) { tint = fresh ? uFresh : uHead; bright = 1.0; }
      }
    }

    if (glyph == 0 && !live) {
      // Filler: every column carries faint rain, a head that wraps with a short trail.
      float h = hash(gc, layer, 7);
      float fHead = fract(h + uTime * mix(3.0, 8.0, hash(gc, layer, 11)) / (rows + 24.0)) * (rows + 24.0);
      float fd = fHead - row;
      if (fd >= 0.0 && fd < 24.0) {
        glyph = 1 + int(hash(gc, int(row), int(floor(uTime * 3.0 + h * 8.0))) * 126.999);
        bright = 0.35 * exp(-fd * 0.18);
      }
    }

    if (glyph > 0) {
      vec2 gcell = vec2(float(glyph % ${ATLAS_COLS}), float(glyph / ${ATLAS_COLS}));
      // Inset a little: no neighbouring glyph bleeds in at a cell's edge, and no mip seam shows as a line.
      vec2 uv = (gcell + clamp(fr, 0.06, 0.94)) / ATLAS;
      float a = textureGrad(uAtlas, uv, dx, dy).r;
      float cover = a * bright * DIM[layer];
      if (uLight > 0.5) col = mix(col, tint, clamp(cover, 0.0, 1.0));
      else col += tint * cover;
    }
  }
  if (uLight < 0.5) col += uBg;
  outColor = vec4(col, 1.0);
}
`;
}
