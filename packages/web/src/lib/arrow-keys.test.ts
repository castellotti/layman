import { describe, it, expect } from 'vitest';
import { arrowKeysFree } from './arrow-keys.js';

const ev = (over: Record<string, unknown> = {}, target: unknown = { tagName: 'DIV' }) =>
  ({ defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, ...over }) as never;
const none = () => false;

describe('arrowKeysFree', () => {
  it('is free on a plain target', () => expect(arrowKeysFree(ev(), none)).toBe(true));
  it('is not free after preventDefault or with a modifier', () => {
    expect(arrowKeysFree(ev({ defaultPrevented: true }), none)).toBe(false);
    for (const k of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) expect(arrowKeysFree(ev({ [k]: true }), none)).toBe(false);
  });
  it('is not free in fields', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(arrowKeysFree(ev({}, { tagName }), none)).toBe(false);
    expect(arrowKeysFree(ev({}, { tagName: 'DIV', isContentEditable: true }), none)).toBe(false);
  });
  it('is not free inside an element that owns arrows', () => {
    expect(arrowKeysFree(ev({}, { tagName: 'DIV', closest: () => ({}) }), none)).toBe(false);
  });
  it('is not free while a modal is open', () => expect(arrowKeysFree(ev(), () => true)).toBe(false));
});
