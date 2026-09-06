import { describe, it, expect } from 'vitest';
import {
  hostAccent,
  HOST_ACCENT_VARS,
  isEditableCuration,
  isRemoteHost,
  hostLabel,
  formatContentBytes,
} from './host.js';

describe('hostAccent', () => {
  it('is deterministic and returns one of the six semantic colours', () => {
    const a = hostAccent('host-1');
    expect(a).toBe(hostAccent('host-1'));
    expect(HOST_ACCENT_VARS).toContain(a);
  });

  it('spreads different ids across the palette', () => {
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => hostAccent(`host-${s}`)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('isEditableCuration', () => {
  it('treats a row with no hostId as local (editable)', () => {
    expect(isEditableCuration({}, 'local')).toBe(true);
  });
  it('is editable when the row is owned by the local host', () => {
    expect(isEditableCuration({ hostId: 'local' }, 'local')).toBe(true);
  });
  it('is read-only when owned by another host', () => {
    expect(isEditableCuration({ hostId: 'remote' }, 'local')).toBe(false);
  });
});

describe('isRemoteHost', () => {
  it('is false for local, undefined, and matching ids', () => {
    expect(isRemoteHost(undefined, 'local')).toBe(false);
    expect(isRemoteHost('local', 'local')).toBe(false);
  });
  it('is true for a different host', () => {
    expect(isRemoteHost('remote', 'local')).toBe(true);
  });
});

describe('hostLabel', () => {
  const names = (id: string) => ({ 'h-remote': 'Workstation' }[id]);
  it('is empty for the local host', () => {
    expect(hostLabel('local', 'local', names)).toBe('');
    expect(hostLabel(undefined, 'local', names)).toBe('');
  });
  it('is the host name for a remote host', () => {
    expect(hostLabel('h-remote', 'local', names)).toBe('Workstation');
  });
  it('falls back to a short id when the name is unknown', () => {
    expect(hostLabel('abcd1234efgh', 'local', () => undefined)).toBe('abcd1234');
  });
});

describe('formatContentBytes', () => {
  it('formats across unit boundaries', () => {
    expect(formatContentBytes(512)).toBe('512 B');
    expect(formatContentBytes(1536)).toBe('1.5 KB');
    expect(formatContentBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatContentBytes(25 * 1024 * 1024)).toBe('25 MB');
  });
});
