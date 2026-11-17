import { describe, expect, it } from 'vitest';
import * as shaders from './gibson3d-shaders.js';

const sources = Object.entries(shaders).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;

describe('the Gibson 3D shaders', () => {
  it('has the programs the scene links', () => {
    for (const name of ['SKY', 'BOARD_VS', 'BOARD_FS', 'PAD_VS', 'PAD_FS', 'CHIP_VS', 'CHIP_FS', 'TOWER_VS', 'TOWER_FS', 'CAR_VS', 'CAR_FS', 'FLASH_VS', 'FLASH_FS', 'ROUTE_VS', 'ROUTE_FS', 'BRIGHT', 'BLUR', 'VERTEX', 'COMPOSITE']) {
      expect(sources.map(([n]) => n)).toContain(name);
    }
  });
  it('each starts with the GLSL ES 3.00 version line', () => {
    for (const [name, src] of sources) expect(src.startsWith('#version 300 es\n'), name).toBe(true);
  });
  it('holds no colour literal: no hex colour, and no vec3 or vec4 of plain numbers beyond 0 and 1', () => {
    for (const [name, src] of sources) {
      // BRIGHT is shared with Matrix 3D: its three numbers are the luminance weights, not a colour.
      if (name === 'BRIGHT') continue;
      expect(src, name).not.toMatch(/#[0-9a-f]{6}\b/i);
      for (const m of src.matchAll(/vec[34]\(\s*(-?[\d.]+(?:\s*,\s*-?[\d.]+){2,3})\s*\)/g)) {
        const nums = m[1].split(',').map((n) => Number(n.trim()));
        expect(nums.every((n) => n === 0 || n === 1), `${name}: vec(${m[1]})`).toBe(true);
      }
    }
  });
  it('writes the page texture layout the packer uses', () => {
    expect(shaders.TOWER_FS).toContain('texelFetch(uPages');
    expect(shaders.TOWER_FS).toContain('textureGrad(uAtlas');
  });
});
