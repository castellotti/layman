import type { StationId } from '../../lib/station.js';
import { STATION_STYLE } from '../../lib/station-style.js';

/**
 * Layman's own glyphs for the stations: plain strokes on a 16 × 16 grid, drawn in the station's
 * colour (`currentColor`), so they theme and print with the rest.
 */
const PATHS: Record<StationId, string> = {
  // a head and shoulders
  you: 'M8 7.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5M3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5',
  // a four-pointed spark
  model: 'M8 1.5C8.6 5.6 10.4 7.4 14.5 8C10.4 8.6 8.6 10.4 8 14.5C7.4 10.4 5.6 8.6 1.5 8C5.6 7.4 7.4 5.6 8 1.5Z',
  // an open book with a ribbon
  memory: 'M8 4C6.5 2.8 4.3 2.5 2 2.8v9.6c2.3-.3 4.5 0 6 1.2c1.5-1.2 3.7-1.5 6-1.2V2.8c-2.3-.3-4.5 0-6 1.2zM8 4v9.6M11 3v4l1-.8l1 .8V2.9',
  // a page with a turned corner
  files: 'M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5',
  // a prompt and a cursor
  shell: 'M2.5 4l4 4l-4 4M8 12.5h5.5',
  // a globe
  network: 'M8 14.5a6.5 6.5 0 1 0 0-13a6.5 6.5 0 1 0 0 13M1.5 8h13M8 1.5c-2.2 2.4-2.2 10.6 0 13M8 1.5c2.2 2.4 2.2 10.6 0 13',
  // a window with its bar and a pointer
  browser: 'M1.5 3h13v10h-13zM1.5 5.8h13M9 8.5l3.5 1.2l-1.5.6l-.6 1.5z',
  // two figures, one behind the other
  agents: 'M6 7a2 2 0 1 0 0-4a2 2 0 1 0 0 4M2 13c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6M11 6.2a1.7 1.7 0 1 0 0-3.4M12 9.6c1.5.4 2.5 1.6 2.5 3.4',
  // a puzzle piece
  skills: 'M2.5 5.5h3a1.5 1.5 0 1 1 3 0h3v3a1.5 1.5 0 1 1 0 3v3h-9v-3a1.5 1.5 0 1 0 0-3z',
  // a shield with a check
  guard: 'M8 1.5l5.5 2v4.2c0 3.3-2.3 5.7-5.5 6.8C4.8 13.4 2.5 11 2.5 7.7V3.5zM5.5 8l1.8 1.8L10.8 6.3',
};

/** `decorative`: shown beside its own name, so hidden from screen readers rather than read twice. */
export function StationGlyph({ station, size = 12, title, decorative = false }: { station: StationId; size?: number; title?: string; decorative?: boolean }) {
  const style = STATION_STYLE[station];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': title ?? style.label })}
      style={{ color: style.color, flexShrink: 0, display: 'block' }}
    >
      {!decorative && <title>{title ?? style.label}</title>}
      <path d={PATHS[station]} />
    </svg>
  );
}
