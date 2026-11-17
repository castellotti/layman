/**
 * GLSL for the Gibson 3D tab, as source strings. Written from the description of the look in the project's own
 * design notes, not from any other shader (docs/extensions/styx.md → Licences).
 *
 * No colour literal: every colour arrives as a uniform or an instance attribute from the scheme's `Palette`;
 * only `vec3(0.0)` and `vec3(1.0)` are written (`gibson3d-shaders.test.ts` checks it). The page texture's layout
 * (16 × 16 pages of 24 × 64 glyph indices) and the instance layout are `lib/gibson-gpu.ts`'s: change both or neither.
 */
import { ATLAS_COLS, ATLAS_ROWS } from '../../lib/matrix-gpu.js';
import { PAGES_ACROSS, PAGE_COLS, PAGE_ROWS } from '../../lib/gibson-gpu.js';
import { CAR_TAIL } from '../../lib/gibson-city.js';

export { COMPOSITE, VERTEX } from '../matrix/matrix3d-shaders.js';

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/** Value noise on a point of the sphere, so the sky has no seam. */
const NOISE = `
float h31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 h22(vec2 p) {
  float a = h21(p);
  return vec2(a, h21(p + a + 17.3));
}
float vn3(vec3 p) {
  vec3 i = floor(p);
  vec3 q = fract(p);
  q = q * q * (3.0 - 2.0 * q);
  return mix(
    mix(mix(h31(i), h31(i + vec3(1.0, 0.0, 0.0)), q.x), mix(h31(i + vec3(0.0, 1.0, 0.0)), h31(i + vec3(1.0, 1.0, 0.0)), q.x), q.y),
    mix(mix(h31(i + vec3(0.0, 0.0, 1.0)), h31(i + vec3(1.0, 0.0, 1.0)), q.x), mix(h31(i + vec3(0.0, 1.0, 1.0)), h31(i + vec3(1.0, 1.0, 1.0)), q.x), q.y),
    q.z);
}
`;

/**
 * Pass 1, the sky: drawn as a full-screen triangle from the view ray, so it turns with the viewer and is infinitely
 * far. An indigo base; two octaves of warped value noise taken as sharpened ridges (the filaments); gold arcs, partial
 * rings in a hashed grid over (azimuth, elevation) that turn slowly; soft clusters of glyphs from the atlas in
 * hashed cells; pale diagonal streaks. Below the horizon it is the board colour. Time moves it; at time 0 it is still.
 */
export const SKY = `${HEAD}
in vec2 vUv;
out vec4 outColor;
uniform mat4 uInvVP;
uniform float uTime;
uniform float uLight;
uniform vec3 uBoard;
uniform vec3 uBase;
uniform vec3 uStrand;
uniform vec3 uArc;
uniform vec3 uFormula;
uniform vec3 uWash;
uniform sampler2D uAtlas;
${NOISE}
const float TAU = 6.2831853;

float arcs(vec2 s, float px) {
  const float N = 24.0;
  float cw = TAU / N;
  vec2 g = s / cw;
  vec2 id = floor(g);
  vec2 q = fract(g) - 0.5;
  id.x = mod(id.x, N);
  float h = h21(id);
  if (h < 0.55) return 0.0;
  vec2 o = (h22(id + 3.7) - 0.5) * 0.4;
  vec2 p = (q - o) * cw;
  float r = length(p);
  float R = 0.025 + 0.04 * h21(id + 9.1);
  float a = atan(p.y, p.x) - uTime * (0.08 + 0.1 * h21(id + 1.3)) * (h > 0.77 ? 1.0 : -1.0);
  float start = h21(id + 5.5) * TAU;
  float span = 1.2 + 2.0 * h21(id + 2.2);
  float m = mod(a - start, TAU);
  float on = step(m, span) * smoothstep(0.0, 0.25, m) * (1.0 - smoothstep(span - 0.25, span, m));
  float w = max(0.0016, px * 1.2);
  return on * (1.0 - smoothstep(w, w * 2.5, abs(r - R)));
}

float formulas(vec2 s) {
  const float CELL = 0.16;
  vec2 g = s / CELL;
  vec2 id = floor(g);
  vec2 q = fract(g);
  vec2 dq = dFdx(g);
  vec2 dr = dFdy(g);
  float h = h21(id + 31.0);
  if (h > 0.1) return 0.0;
  float glyph = 1.0 + floor(h21(id + 8.8) * 40.0);
  vec2 cell = vec2(mod(glyph, ${f(ATLAS_COLS)}), floor(glyph / ${f(ATLAS_COLS)}));
  vec2 pos = (q - 0.5) / 0.7 + 0.5;
  if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0) return 0.0;
  vec2 inv = vec2(1.0 / ${f(ATLAS_COLS)}, 1.0 / ${f(ATLAS_ROWS)});
  vec2 uv = (cell + vec2(0.2, 0.1) + pos * vec2(0.6, 0.8)) * inv;
  float soft = 0.5 + 0.5 * sin(uTime * 0.2 + h * 40.0);
  return textureGrad(uAtlas, uv, dq * vec2(0.6, 0.8) * inv / 0.7, dr * vec2(0.6, 0.8) * inv / 0.7).r * (0.5 + 0.5 * soft);
}

void main() {
  if (uLight > 0.5) { outColor = vec4(uBoard, 1.0); return; }
  vec2 ndc = vec2(vUv.x * 2.0 - 1.0, 1.0 - vUv.y * 2.0);
  vec4 w = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w);
  float az = atan(d.x, -d.z);
  float el = asin(clamp(d.y, -1.0, 1.0));
  vec2 s = vec2(az, el);
  float t = uTime;

  // Filaments: two octaves of warped noise, each a sharpened ridge.
  vec3 q = d * 2.2 + vec3(t * 0.012, t * 0.006, -t * 0.009);
  q += 0.6 * vec3(vn3(q * 1.3 + 3.1), vn3(q * 1.3 + 7.7), vn3(q * 1.3 + 1.9));
  float r1 = pow(1.0 - abs(2.0 * vn3(q * 1.7) - 1.0), 5.0);
  float r2 = pow(1.0 - abs(2.0 * vn3(q * 3.9 + 5.0) - 1.0), 4.0);
  float fil = (r1 * 0.6 + r2 * 0.4) * (0.55 + 0.45 * vn3(d * 1.5 + 11.0));

  float px = fwidth(el);
  float arc = arcs(s, px);
  float fm = formulas(s);
  // Pale streaks, long along one diagonal of the sky.
  float along = d.x * 0.8 + d.y * 0.6;
  float across = -d.x * 0.6 + d.y * 0.8;
  float streak = smoothstep(0.82, 0.96, vn3(vec3(along * 3.0, across * 48.0, d.z * 3.0 + t * 0.01)));

  vec3 sky = uBase + uStrand * fil * 0.5 + uArc * arc * 0.9 + uFormula * fm * 0.35 + uWash * streak * 0.2;
  // Toward the horizon it hazes into the board, and below it it is the board.
  outColor = vec4(mix(uBoard, sky, smoothstep(-0.01, 0.2, d.y)), 1.0);
}
`;

/** The shared start of the board's, the pads' and the towers' vertex shaders: nothing but the camera. */
const CAMERA = `
uniform mat4 uVP;
`;

/** A quad from `gl_VertexID` as a triangle strip: corner in -1..1. */
const CORNER = `
vec2 corner() { return vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0; }
`;

/** Pass 2, the board: one quad at y = 0, its pattern computed per fragment from the world position. */
export const BOARD_VS = `${HEAD}${CAMERA}${CORNER}
uniform float uHalf;
out vec3 vW;
void main() {
  vec2 c = corner() * uHalf;
  vW = vec3(c.x, 0.0, c.y);
  gl_Position = uVP * vec4(vW, 1.0);
}
`;

/**
 * Streets are 4 wide, centred on x = 16 k + 8 and z = 16 k + 8, with five traces at -1.6, -0.8, 0, 0.8, 1.6 from the
 * centre line (A, B, A, B, A); inside a block a dimmer decoration from a hash of the block and a 1-unit cell. A slow
 * pulse runs along each trace, and everything fades to the board colour between 120 and 220 units from the camera.
 */
export const BOARD_FS = `${HEAD}
in vec3 vW;
out vec4 outColor;
uniform vec3 uCam;
uniform float uTime;
uniform float uLight;
uniform vec3 uBoard;
uniform vec3 uTraceA;
uniform vec3 uTraceB;
${NOISE}

float line(float d, float w, float aa) { return 1.0 - smoothstep(w, w + aa, d); }

/** rgb: the trace colour weighted by how much of it is here; a: that amount. */
vec4 street(float d, float along, float aa) {
  float w = max(0.035, aa * 0.7);
  float a = line(abs(d), w, aa) + line(abs(d - 1.6), w, aa);
  float b = line(abs(d - 0.8), w, aa);
  float pulse = 0.65 + 0.35 * sin(along * 0.25 - uTime * 1.5 + d * 3.0);
  float within = 1.0 - smoothstep(2.0, 2.0 + aa * 2.0, d);
  // A trace narrower than a pixel is dimmed by how much narrower, or the lines pile up into a white band at the horizon.
  float k = pulse * within * min(1.0, 0.25 / aa);
  float bed = 0.05 * (1.0 - smoothstep(0.0, 2.0, d)) * within;
  return vec4((uTraceA * a + uTraceB * b) * k + uTraceA * bed, (a + b) * k + bed);
}

float decoration(vec2 f, float h, float w, float aa) {
  int t = int(floor(h * 5.0));
  float horiz = line(abs(f.y - 0.5), w, aa) * step(0.1, f.x) * step(f.x, 0.9);
  float vert = line(abs(f.x - 0.5), w, aa) * step(0.1, f.y) * step(f.y, 0.9);
  if (t == 1) return horiz;
  if (t == 2) return vert;
  if (t == 3) return max(horiz * step(f.x, 0.5), vert * step(0.5, f.y));
  if (t == 4) return line(abs(length(f - 0.5) - 0.22), w, aa);
  return 0.0;
}

void main() {
  vec2 p = vW.xz;
  vec2 ds = abs(mod(p, 16.0) - 8.0);
  vec2 aa = max(fwidth(p), vec2(0.0005));
  // A street along x is found by the distance in z, and the other way round; both can be here (a crossing).
  vec4 sx = street(ds.y, p.x, aa.y);
  vec4 sz = street(ds.x, p.y, aa.x);
  vec4 acc = sx + sz;

  float inBlock = smoothstep(2.0, 2.0 + aa.x * 2.0, ds.x) * smoothstep(2.0, 2.0 + aa.y * 2.0, ds.y);
  if (inBlock > 0.0) {
    vec2 block = floor((p + 8.0) / 16.0);
    vec2 cell = floor(p);
    float h = h31(vec3(block, cell.x * 0.37 + cell.y * 1.7));
    float w = max(0.025, aa.x * 0.7);
    float k = decoration(fract(p), h, w, aa.x) * inBlock * 0.3 * min(1.0, 0.2 / aa.x);
    vec3 tint = mix(uTraceA, uTraceB, step(0.5, h21(cell * 7.0 + block)));
    acc += vec4(tint * k, k);
  }

  vec3 col;
  if (uLight > 0.5) col = mix(uBoard, acc.rgb / max(acc.a, 0.001), clamp(acc.a, 0.0, 1.0));
  else col = uBoard + acc.rgb;
  float fade = 1.0 - smoothstep(120.0, 220.0, distance(uCam, vW));
  outColor = vec4(mix(uBoard, col, fade), 1.0);
}
`;

/** The unit cube's corners and normals are attributes 4 and 5; the tower's instance data is 0..3. */
const TOWER_ATTRS = `
layout(location = 0) in vec4 aA;   // x, z, side, height
layout(location = 1) in vec4 aB;   // glass r g b, brightness
layout(location = 2) in vec4 aC;   // text r g b, page index
layout(location = 3) in vec4 aD;   // cap fraction, flags, page rows, riseAt
layout(location = 4) in vec3 aPos;
layout(location = 5) in vec3 aNrm;
`;

/** Each tower's soft light on the board under it: an additive quad 2.4 × its side, a radial falloff of its glass. */
export const PAD_VS = `${HEAD}${CAMERA}${CORNER}${TOWER_ATTRS}
uniform float uTime;
out vec2 vC;
flat out vec3 vGlass;
flat out float vBright;
void main() {
  vec2 c = corner();
  vC = c;
  vGlass = aB.rgb;
  vBright = aB.w;
  vec2 xz = aA.xy + c * aA.z * 1.2;
  gl_Position = uVP * vec4(xz.x, 0.03, xz.y, 1.0);
}
`;
export const PAD_FS = `${HEAD}
in vec2 vC;
flat in vec3 vGlass;
flat in float vBright;
out vec4 outColor;
void main() {
  float r = length(vC);
  float k = pow(max(0.0, 1.0 - r), 2.0) * 0.2 * vBright;
  outColor = vec4(vGlass * k, 1.0);
}
`;

/** The home chips: instanced boxes 2.0 × 0.6 × 2.0, opaque, dark, a rim along the top edges and pins along two base edges. */
export const CHIP_VS = `${HEAD}${CAMERA}
layout(location = 4) in vec3 aPos;
layout(location = 5) in vec3 aNrm;
layout(location = 6) in vec2 aAt;
out vec3 vW;
flat out vec3 vN;
flat out vec2 vAt;
void main() {
  vec3 w = vec3(aAt.x + aPos.x * 2.0, (aPos.y + 0.5) * 0.6, aAt.y + aPos.z * 2.0);
  vW = w;
  vN = aNrm;
  vAt = aAt;
  gl_Position = uVP * vec4(w, 1.0);
}
`;
export const CHIP_FS = `${HEAD}
in vec3 vW;
flat in vec3 vN;
flat in vec2 vAt;
out vec4 outColor;
uniform vec3 uBoard;
uniform vec3 uRim;
void main() {
  vec3 body = mix(uBoard, uRim, 0.12);
  vec2 l = vW.xz - vAt;
  float rim = 0.0;
  if (vN.y > 0.5) {
    float e = 1.0 - max(abs(l.x), abs(l.y));
    rim = 1.0 - smoothstep(0.06, 0.06 + fwidth(e) * 1.5, e);
  } else {
    float top = 0.6 - vW.y;
    rim = 1.0 - smoothstep(0.045, 0.045 + fwidth(top) * 1.5, top);
    // Pins along the two faces that look along x: eight teeth near the board.
    if (abs(vN.x) > 0.5) {
      float tooth = step(0.3, fract((l.y + 1.0) * 4.0)) * step(fract((l.y + 1.0) * 4.0), 0.7);
      rim = max(rim, tooth * step(vW.y, 0.16));
    }
  }
  float shade = vN.y > 0.5 ? 1.0 : 0.8;
  outColor = vec4(mix(body * shade, uRim, clamp(rim, 0.0, 1.0)), 1.0);
}
`;

const COLS = f(PAGE_COLS);
const PAGES_ACROSS_F = f(PAGES_ACROSS);

/**
 * The towers: one unit cube per tower, scaled in the vertex shader to side × height × side (the height times its rise).
 * Additive on a dark board (every face of every tower adds its light, so they show through each other); on a light
 * board the fragment's alpha covers instead and the pipeline culls back faces.
 */
export const TOWER_VS = `${HEAD}${CAMERA}${TOWER_ATTRS}
uniform float uTime;
uniform int uArrN;
uniform vec2 uArr[16];
out vec3 vWorld;
flat out vec3 vNrm;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vD;
flat out float vBright;
flat out float vH;
void main() {
  float rise = 1.0;
  if (aD.w > -1000.0) {
    float k = clamp((uTime - aD.w) / 1.2, 0.0, 1.0);
    rise = k * k * (3.0 - 2.0 * k);
  }
  float h = aA.w * max(rise, 0.001);
  vec3 w = vec3(aA.x + aPos.x * aA.z, (aPos.y + 0.5) * h, aA.y + aPos.z * aA.z);
  float boost = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uArrN) break;
    if (int(uArr[i].x + 0.5) == gl_InstanceID) boost = max(boost, clamp(1.0 - (uTime - uArr[i].y) / 0.4, 0.0, 1.0));
  }
  int flags = int(aD.y + 0.5);
  float pulse = ((flags & 16) != 0) ? 1.0 + 0.15 * sin(uTime * 3.1415927) : 1.0;
  vWorld = w;
  vNrm = aNrm;
  vA = aA; vB = aB; vC = aC; vD = aD;
  vBright = aB.w * pulse * (1.0 + 0.25 * boost);
  vH = h;
  gl_Position = uVP * vec4(w, 1.0);
}
`;

/**
 * A side face is a grid of 24 character cells across and rows 1.5 times as high, showing the tower's page repeated
 * down it. The glyph is fetched from the page texture and drawn from the atlas with `textureGrad`, the gradients
 * taken from the continuous cell coordinate before any floor or fract (or a glyph would take its mip level from its
 * neighbour); far away the glyphs fade into bars, one per lit row, and into the row's average when a row is under
 * a few pixels, so nothing shimmers.
 */
export const TOWER_FS = `${HEAD}
in vec3 vWorld;
flat in vec3 vNrm;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
flat in float vBright;
flat in float vH;
out vec4 outColor;
uniform sampler2D uAtlas;
uniform sampler2D uPages;
uniform vec3 uCam;
uniform vec3 uBlocked;
uniform vec3 uBoard;
uniform float uLight;
uniform float uMarks;
${NOISE}

void main() {
  bool top = vNrm.y > 0.5;
  float side = vA.z;
  vec2 lp = vWorld.xz - vA.xy;
  float d = vH - vWorld.y;
  int flags = int(vD.y + 0.5);
  float dist = distance(uCam, vWorld);

  // Across the face, 0..1, left to right as seen from outside.
  float u;
  if (abs(vNrm.z) > 0.5) u = (vNrm.z > 0.0 ? lp.x : -lp.x) / side + 0.5;
  else u = (vNrm.x > 0.0 ? -lp.y : lp.y) / side + 0.5;

  // The character cell, continuous (its derivatives are taken here, before anything branches).
  float cell = side / ${COLS};
  vec2 cc = vec2(u * ${COLS}, d / (cell * 1.5));
  vec2 ddx = dFdx(cc);
  vec2 ddy = dFdy(cc);
  float rowPx = 1.0 / max(fwidth(cc.y), 0.0001);

  // Edges: bright within 0.05 units of a face border and never thinner than a pixel.
  float edgeD;
  float along;
  if (top) {
    edgeD = side * 0.5 - max(abs(lp.x), abs(lp.y));
    along = abs(lp.x) > abs(lp.y) ? lp.y : lp.x;
  } else {
    float a = min(u, 1.0 - u) * side;
    float b = min(d, vWorld.y);
    edgeD = min(a, b);
    along = a < b ? vWorld.y : u * side;
  }
  float aa = fwidth(edgeD) + 0.00001;
  float ew = max(0.05, aa);
  float edge = 1.0 - smoothstep(ew, ew + aa, edgeD);
  if ((flags & 2) != 0) edge *= step(0.4, mod(along, 0.8));
  bool selected = (flags & 8) != 0;

  vec3 glass = vB.rgb;
  vec3 text = vC.rgb;
  bool inCap = vD.x > 0.0 && d < vD.x * vH;
  if (inCap) { glass = uBlocked; text = mix(uBlocked, vec3(1.0), 0.45); }
  bool striped = (flags & 1) != 0 || (inCap && uMarks > 0.5);

  float cov = 0.0;
  if (!top && vC.w >= -0.5) {
    vec2 f = fract(cc);
    ivec2 ic = ivec2(floor(cc));
    int page = int(vC.w + 0.5);
    int rows = max(1, int(vD.z + 0.5));
    ivec2 org = ivec2((page % ${PAGES_ACROSS}) * ${PAGE_COLS}, (page / ${PAGES_ACROSS}) * ${PAGE_ROWS});
    int row = max(ic.y, 0) % rows;
    int col = clamp(ic.x, 0, ${PAGE_COLS - 1});
    int g = int(texelFetch(uPages, org + ivec2(col, row), 0).r * 255.0 + 0.5);
    vec2 inv = vec2(1.0 / ${f(ATLAS_COLS)}, 1.0 / ${f(ATLAS_ROWS)});
    vec2 scale = vec2(0.6, 0.8) * inv;
    vec2 guv = (vec2(float(g % ${ATLAS_COLS}), float(g / ${ATLAS_COLS})) + vec2(0.2, 0.1) + f * vec2(0.6, 0.8)) * inv;
    float glyph = textureGrad(uAtlas, guv, ddx * scale, ddy * scale).r;
    float lit = g != 0 ? 1.0 : 0.0;
    float band = smoothstep(0.2, 0.3, f.y) * (1.0 - smoothstep(0.7, 0.8, f.y));
    // A lit row reads as a bar; a row of a few pixels as its average, so it cannot shimmer.
    float bar = lit * mix(0.17, band * 0.5, smoothstep(2.0, 5.0, rowPx));
    if ((flags & 4) != 0) {
      float on = h31(vec3(float(page), float(row), float(col))) < 0.7 ? 1.0 : 0.0;
      bar = on * mix(0.33, band, smoothstep(2.0, 5.0, rowPx));
    }
    cov = mix(glyph, bar, smoothstep(40.0, 70.0, dist));
  }

  float fill = top ? 0.22 : 0.10;
  float stripe = step(0.5, fract(((top ? lp.x + lp.y : u * side) + d) / 0.6));
  if (striped) cov *= 0.3;

  if (uLight > 0.5) {
    // Cover, not light: the glass tints the board and the text darkens it.
    float k = clamp(0.3 + 0.35 * vBright + edge * 0.35 + (top ? 0.12 : 0.0), 0.0, 1.0);
    vec3 c = mix(uBoard, glass, k);
    c = mix(c, text, clamp(cov, 0.0, 1.0));
    if (striped) c = mix(c, glass, 0.35 * stripe);
    outColor = vec4(c, 0.9);
    return;
  }

  vec3 c = glass * (fill + edge * (selected ? 1.25 : 0.65)) + text * cov;
  if (striped) c += glass * 0.28 * stripe;
  outColor = vec4(c * vBright, 1.0);
}
`;

/**
 * The traffic: instanced quads on the board at y = 0.06, 3 long and 0.25 wide, along each car's direction, brightest at
 * the head and fading down the tail. A car that flashes at a refusing tower is also a bright disc (a second draw
 * of the same instances).
 */
const CAR_ATTRS = `
layout(location = 0) in vec4 aCar;   // head x, z, direction x, z
layout(location = 1) in vec4 aTone;  // colour, flash
`;
export const CAR_VS = `${HEAD}${CAMERA}${CORNER}${CAR_ATTRS}
out vec2 vS;
flat out vec3 vTone;
void main() {
  vec2 c = corner();
  float along = c.x * 0.5 + 0.5;
  vec2 dir = aCar.zw;
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 xz = aCar.xy - dir * ${f(CAR_TAIL)} * (1.0 - along) + perp * c.y * 0.125;
  vS = vec2(along, c.y);
  vTone = aTone.rgb;
  gl_Position = uVP * vec4(xz.x, 0.06, xz.y, 1.0);
}
`;
export const CAR_FS = `${HEAD}
in vec2 vS;
flat in vec3 vTone;
out vec4 outColor;
uniform float uLight;
void main() {
  float k = pow(vS.x, 2.5) * (1.0 - smoothstep(0.5, 1.0, abs(vS.y)));
  vec3 c = mix(vTone, vec3(1.0), smoothstep(0.85, 1.0, vS.x) * 0.6);
  outColor = uLight > 0.5 ? vec4(c, k) : vec4(c * k, 1.0);
}
`;
export const FLASH_VS = `${HEAD}${CAMERA}${CORNER}${CAR_ATTRS}
out vec2 vC;
flat out float vFlash;
void main() {
  vec2 c = corner();
  vC = c;
  vFlash = aTone.w;
  vec2 xz = aCar.xy + c * 0.9;
  gl_Position = uVP * vec4(xz.x, 0.07, xz.y, 1.0);
}
`;
export const FLASH_FS = `${HEAD}
in vec2 vC;
flat in float vFlash;
out vec4 outColor;
uniform vec3 uFlash;
uniform float uLight;
void main() {
  if (vFlash <= 0.0) discard;
  float k = pow(max(0.0, 1.0 - length(vC)), 2.0) * vFlash;
  outColor = uLight > 0.5 ? vec4(uFlash, k) : vec4(uFlash * k, 1.0);
}
`;
