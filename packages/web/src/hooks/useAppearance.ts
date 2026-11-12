import { useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { applyTheme, rememberAppearance } from '../lib/theme-runtime.js';

/**
 * Applies the config's appearance block whenever it changes (on connect and on every
 * `session:config`), and remembers it for the next page load. Before the config arrives the page
 * keeps what `main.tsx` applied. Called once, from `App`.
 */
export function useAppearance(): void {
  const appearance = useSessionStore((s) => s.config?.appearance);
  useEffect(() => {
    if (appearance === undefined) return;
    applyTheme(appearance);
    rememberAppearance(appearance);
  }, [appearance]);
}
