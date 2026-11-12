import { useSyncExternalStore } from 'react';
import { getThemeVersion, subscribeTheme } from '../lib/theme-runtime.js';

/**
 * A number that changes whenever the theme is applied. A view that reads colours once (a canvas,
 * an SVG built from `readToken`, xyflow's props) puts it in its effect or memo dependencies so a
 * theme change redraws it; views that use `var(--…)` follow the theme on their own.
 */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribeTheme, getThemeVersion, getThemeVersion);
}
