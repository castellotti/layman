import { describe, expect, it } from 'vitest';
import { EVENT_GLYPH } from './EventIcon.js';
import { NODE_BORDER_COLORS } from '../../lib/event-styles.js';

describe('event icons', () => {
  it('every event type that has a flowchart colour has its own icon', () => {
    expect(Object.keys(NODE_BORDER_COLORS).filter((t) => !(t in EVENT_GLYPH))).toEqual([]);
  });
});
