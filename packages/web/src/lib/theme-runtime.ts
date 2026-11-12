/**
 * The DOM side of themes: write a resolved appearance into the page and tell views that read
 * colours once (canvas, SVG, xyflow) to read them again. `themes.ts` stays pure; this is the only
 * file that touches `document` for it.
 */
import { appearanceCss, resolveAppearance, type Appearance, type ResolvedAppearance } from './themes.js';

const STYLE_ID = 'layman-theme';

let version = 0;
const listeners = new Set<() => void>();

/** Changes every time `applyTheme` writes; `useSyncExternalStore`-compatible with `subscribeTheme`. */
export const getThemeVersion = (): number => version;

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const query = (q: string): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches;

/**
 * Resolve `appearance` against the browser's colour-scheme and reduced-motion settings and write
 * it: one `<style>` element (screen only, so print keeps its light palette) and `data-theme`,
 * `data-scheme`, `data-motion` on `<html>`. Does nothing to the page when nothing changed.
 */
export function applyTheme(appearance: Appearance, doc: Document = document): ResolvedAppearance {
  const resolved = resolveAppearance(appearance, {
    prefersDark: query('(prefers-color-scheme: dark)'),
    prefersReducedMotion: query('(prefers-reduced-motion: reduce)'),
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

/** The current value of a CSS variable, e.g. `readToken('warn')`, for code that cannot use `var()`. */
export function readToken(token: string, doc: Document = document): string {
  return getComputedStyle(doc.documentElement).getPropertyValue(`--${token}`).trim();
}
