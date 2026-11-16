import { describe, expect, it } from 'vitest';
import { MATRIX_WINDOWS, matrixUrl, parseMatrixWindow } from './matrix-feed.js';

describe('matrixUrl', () => {
  it('asks for one session and a window', () => {
    expect(matrixUrl({ sessionId: 'abc', window: '15m' })).toBe('/api/styx/v1/matrix?session=abc&relative=15m');
    expect(matrixUrl({ sessionId: 'abc', window: '1m' })).toBe('/api/styx/v1/matrix?session=abc&relative=60s');
    expect(matrixUrl({ sessionId: 'abc', window: 'all' })).toBe('/api/styx/v1/matrix?session=abc');
  });
  it('with no session asks for every live one, over a window the server can answer', () => {
    expect(matrixUrl({ sessionId: null, window: '1h' })).toBe('/api/styx/v1/matrix?relative=1h');
    expect(matrixUrl({ sessionId: null, window: 'all' })).toBe('/api/styx/v1/matrix?relative=1d');
  });
  it('encodes the id and only ever emits a /api/styx/ path', () => {
    for (const w of MATRIX_WINDOWS) {
      for (const sessionId of [null, 'a b&c=d', '../../etc']) {
        const url = matrixUrl({ sessionId, window: w.id });
        expect(url.startsWith('/api/styx/v1/matrix')).toBe(true);
        expect(url.split('?')[0]).toBe('/api/styx/v1/matrix'); // the id only ever rides in the query
      }
    }
    expect(matrixUrl({ sessionId: 'a b&c=d', window: 'all' })).toBe('/api/styx/v1/matrix?session=a+b%26c%3Dd');
  });
  it('parses a stored window', () => {
    expect(parseMatrixWindow('1h')).toBe('1h');
    expect(parseMatrixWindow('2h')).toBeNull();
  });
});
