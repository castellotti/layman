import { describe, expect, it, vi } from 'vitest';
import { applyTheme, getThemeVersion, rememberAppearance, rememberedAppearance, subscribeTheme } from './theme-runtime.js';
import { DEFAULT_APPEARANCE } from './themes.js';

/** Just enough of a Document for applyTheme (the web tests run in node, without a DOM). */
function fakeDocument() {
  const byId = new Map<string, { id: string; textContent: string | null }>();
  return {
    documentElement: { dataset: {} as Record<string, string> },
    head: { appendChild: (el: { id: string; textContent: string | null }) => byId.set(el.id, el) },
    createElement: () => ({ id: '', textContent: null as string | null }),
    getElementById: (id: string) => byId.get(id) ?? null,
  };
}

describe('applyTheme', () => {
  it('writes one screen-only style element and the data attributes, and bumps the version once per change', () => {
    const doc = fakeDocument();
    const d = doc as unknown as Document;
    let calls = 0;
    const off = subscribeTheme(() => { calls += 1; });
    const v0 = getThemeVersion();

    applyTheme({ ...DEFAULT_APPEARANCE, theme: 'paper' }, d);
    expect(doc.documentElement.dataset).toEqual({ theme: 'paper', scheme: 'light', motion: 'full' });
    expect(doc.getElementById('layman-theme')?.textContent).toMatch(/^@media screen \{/);
    expect(getThemeVersion()).toBe(v0 + 1);

    applyTheme({ ...DEFAULT_APPEARANCE, theme: 'paper' }, d); // unchanged: no redraws
    expect(getThemeVersion()).toBe(v0 + 1);

    applyTheme({ ...DEFAULT_APPEARANCE, theme: 'ember' }, d);
    expect(doc.documentElement.dataset.theme).toBe('ember');
    expect(getThemeVersion()).toBe(v0 + 2);
    expect(calls).toBe(2);

    off();
    applyTheme(DEFAULT_APPEARANCE, d);
    expect(calls).toBe(2);
  });
});

describe('following the OS', () => {
  it('re-applies when the OS switches between dark and light', () => {
    const queries = new Map<string, { matches: boolean; fire: () => void }>();
    vi.stubGlobal('window', {
      matchMedia: (q: string) => {
        if (!queries.has(q)) {
          const handlers: Array<() => void> = [];
          const entry = {
            matches: q.includes('dark'),
            addEventListener: (_: string, h: () => void) => handlers.push(h),
            fire: () => handlers.forEach((h) => h()),
          };
          queries.set(q, entry);
        }
        return queries.get(q);
      },
    });
    try {
      const doc = fakeDocument();
      applyTheme({ theme: 'system' }, doc as unknown as Document);
      expect(doc.documentElement.dataset.theme).toBe('classic');
      const dark = queries.get('(prefers-color-scheme: dark)')!;
      dark.matches = false;
      dark.fire();
      expect(doc.documentElement.dataset.theme).toBe('daylight');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the remembered appearance', () => {
  function fakeStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
  }

  it('gives back what was remembered, and null when nothing was', () => {
    const s = fakeStorage();
    expect(rememberedAppearance(s)).toBeNull();
    rememberAppearance({ ...DEFAULT_APPEARANCE, theme: 'tide' }, s);
    expect(rememberedAppearance(s)).toEqual({ ...DEFAULT_APPEARANCE, theme: 'tide' });
  });

  it('never throws: no storage, storage that refuses, or a corrupt value', () => {
    expect(rememberedAppearance(null)).toBeNull();
    const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(() => rememberAppearance(DEFAULT_APPEARANCE, refusing)).not.toThrow();
    expect(rememberedAppearance(refusing)).toBeNull();
    // Blocked site data: merely reading window.localStorage throws.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      expect(rememberedAppearance()).toBeNull();
      expect(() => rememberAppearance(DEFAULT_APPEARANCE)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    const corrupt = fakeStorage();
    corrupt.setItem('layman.appearance', '{not json');
    expect(rememberedAppearance(corrupt)).toBeNull();
  });
});
