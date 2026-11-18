import { describe, expect, it } from 'vitest';
import { godotFrameSrc, godotTabState, godotViewState } from './matrix-godot.js';

describe('godotFrameSrc', () => {
  it('is a same-origin path with the embed parameters', () => {
    expect(godotFrameSrc({ sessionId: 'abc-1', window: '15m' }))
      .toBe('/styx/godot/index.html?embed=1&api=/api/styx&poll=2&relative=15m&session=abc-1');
    expect(godotFrameSrc({ sessionId: null, window: '1m' })).toContain('relative=60s');
  });

  it('omits relative for All on a session, and asks for a day with no session', () => {
    expect(godotFrameSrc({ sessionId: 's', window: 'all' })).not.toContain('relative');
    expect(godotFrameSrc({ sessionId: null, window: 'all' })).toContain('relative=1d');
  });

  it('encodes the session id and never starts with // or http', () => {
    const src = godotFrameSrc({ sessionId: 'a&b=c', window: '1h' });
    expect(src).toContain('session=a%26b%3Dc');
    expect(src).toMatch(/^\/styx\/godot\//);
  });
});

describe('godotTabState', () => {
  const base = { secure: true, buildPresent: true, motionFull: true, runAnyway: false };
  it('runs when everything allows it', () => expect(godotTabState(base)).toBe('run'));
  it('puts an insecure page first', () => {
    expect(godotTabState({ ...base, secure: false, buildPresent: false })).toBe('insecure');
  });
  it('waits for the status, then explains a missing build', () => {
    expect(godotTabState({ ...base, buildPresent: null })).toBe('checking');
    expect(godotTabState({ ...base, buildPresent: false })).toBe('no-build');
  });
  it('does not start the engine under reduced motion until asked', () => {
    expect(godotTabState({ ...base, motionFull: false })).toBe('motion-off');
    expect(godotTabState({ ...base, motionFull: false, runAnyway: true })).toBe('run');
  });
});

describe('godotFrameSrc for Gibson', () => {
  it('leaves the Matrix address as it was, whatever the options', () => {
    expect(godotFrameSrc({ sessionId: 'abc-1', window: '15m', viz: 'matrix' })).toBe(godotFrameSrc({ sessionId: 'abc-1', window: '15m' }));
  });
  it('asks for the view and the scheme', () => {
    expect(godotFrameSrc({ sessionId: 'abc-1', window: '15m', viz: 'gibson', scheme: 'night' }))
      .toBe('/styx/godot/index.html?embed=1&api=/api/styx&poll=2&viz=gibson&scheme=night&relative=15m&session=abc-1');
    expect(godotFrameSrc({ sessionId: null, window: 'all', viz: 'gibson' })).not.toContain('scheme');
  });
  it('stays a same-origin path', () => {
    expect(godotFrameSrc({ sessionId: 'x', window: '1h', viz: 'gibson', scheme: 'green' })).toMatch(/^\/styx\/godot\//);
  });
});

describe('godotViewState', () => {
  it('is always ok for the Matrix, which every build has', () => {
    expect(godotViewState(undefined, 'matrix', 0)).toBe('ok');
    expect(godotViewState(undefined, 'matrix', 60_000)).toBe('ok');
  });
  it('is ok when the page lists the view', () => expect(godotViewState(['matrix', 'gibson'], 'gibson', 0)).toBe('ok'));
  it('is missing when the page lists views without it', () => expect(godotViewState(['matrix'], 'gibson', 0)).toBe('missing'));
  it('waits while the page has not reported, then gives up', () => {
    expect(godotViewState(undefined, 'gibson', 0)).toBe('waiting');
    expect(godotViewState(undefined, 'gibson', 14_999)).toBe('waiting');
    expect(godotViewState(undefined, 'gibson', 15_000)).toBe('missing');
  });
  it('does not take a non-list for a report', () => expect(godotViewState('gibson', 'gibson', 1000)).toBe('waiting'));
});
