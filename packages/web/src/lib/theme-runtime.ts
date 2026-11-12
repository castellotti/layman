/**
 * The DOM side of themes: write a resolved appearance into the page and tell views that read
 * colours once (canvas, SVG, xyflow) to read them again. `themes.ts` stays pure; this is the only
 * file that touches `document` for it.
 */
import { appearanceCss, resolveAppearance, type ResolvedAppearance } from './themes.js';

const STYLE_ID = 'layman-theme';

let version = 0;
const listeners = new Set<() => void>();

/** Changes every time `applyTheme` writes; `useSyncExternalStore`-compatible with `subscribeTheme`. */
export const getThemeVersion = (): number => version;

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const DARK = '(prefers-color-scheme: dark)';
const REDUCE = '(prefers-reduced-motion: reduce)';
const media = (q: string): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null;

/** What was last applied, so an OS change (dark/light, reduced motion) can re-apply it. */
let current: { appearance: unknown; doc: Document } | null = null;
let watching = false;

function watchSystem(): void {
  if (watching) return;
  const lists = [media(DARK), media(REDUCE)];
  if (!lists[0]) return;
  watching = true;
  const reapply = () => { if (current) applyTheme(current.appearance, current.doc); };
  for (const l of lists) l?.addEventListener('change', reapply);
}

/**
 * Resolve `appearance` (any stored value: it is normalised) against the browser's colour-scheme
 * and reduced-motion settings and write it: one `<style>` element (the theme for the screen, and the
 * print palette, `PRINT_THEME`, for print) and `data-theme`, `data-scheme`, `data-motion` on `<html>`. Re-applies by itself
 * when either OS setting changes. Does nothing to the page when nothing changed.
 */
export function applyTheme(appearance: unknown, doc: Document = document): ResolvedAppearance {
  current = { appearance, doc };
  watchSystem();
  const resolved = resolveAppearance(appearance, {
    prefersDark: media(DARK)?.matches ?? false,
    prefersReducedMotion: media(REDUCE)?.matches ?? false,
  });
  const css = appearanceCss(resolved);
  let style = doc.getElementById(STYLE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  const root = doc.documentElement;
  if (
    style.textContent === css &&
    root.dataset.theme === resolved.theme.id &&
    root.dataset.motion === resolved.motion
  ) {
    return resolved;
  }
  style.textContent = css;
  root.dataset.theme = resolved.theme.id;
  root.dataset.scheme = resolved.theme.scheme;
  root.dataset.motion = resolved.motion;
  version += 1;
  for (const l of listeners) l();
  return resolved;
}

const STORAGE_KEY = 'layman.appearance';

/**
 * `storage`, else the page's localStorage, read inside the callers' `try`: with site data blocked or in a
 * sandboxed iframe, merely reading `window.localStorage` throws, and a default parameter would
 * throw before any `try` and leave the page blank.
 */
const storageOr = (storage: Storage | null | undefined): Storage | null =>
  storage !== undefined ? storage : typeof localStorage === 'undefined' ? null : localStorage;

/**
 * The appearance this browser last applied from the config, kept so the next page load starts in
 * it instead of flashing the default until the WebSocket delivers the config. Null when none was
 * kept or storage is unavailable; `applyTheme` normalises whatever comes back.
 */
export function rememberedAppearance(storage?: Storage | null): unknown {
  try {
    const raw = storageOr(storage)?.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function rememberAppearance(appearance: unknown, storage?: Storage | null): void {
  try {
    storageOr(storage)?.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Private mode or full storage: the next load shows the default until the config arrives.
  }
}

/** The current value of a CSS variable, e.g. `readToken('warn')`, for code that cannot use `var()`. */
export function readToken(token: string, doc: Document = document): string {
  return getComputedStyle(doc.documentElement).getPropertyValue(`--${token}`).trim();
}
