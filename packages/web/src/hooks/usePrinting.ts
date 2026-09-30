import { useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';

/**
 * True while the page is being printed (Export to PDF or the browser's own ⌘P).
 *
 * Collapsed content — a code block or diff past its `maxLines`, a closed Thinking block, a closed
 * sub-agent transcript — is only reachable through a button, and print hides every button, so a
 * printed transcript would be cut short with nothing saying so. Components that collapse content
 * read this and render in full while printing.
 *
 * The flag is raised inside `flushSync` on `beforeprint`: the browser lays out the printed page as
 * soon as the listeners return, so an ordinary (batched, deferred) React update would land after
 * the page had already been captured in its collapsed form. Lowering it on `afterprint` has no
 * such deadline, so that update is left to React's scheduler.
 */
let printing = false;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (printing === value) return;
  printing = value;
  const notify = () => listeners.forEach((l) => l());
  if (value) flushSync(notify);
  else notify();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', () => set(true));
  window.addEventListener('afterprint', () => set(false));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrinting(): boolean {
  return useSyncExternalStore(subscribe, () => printing, () => false);
}

/**
 * `useState(false)` for a disclosure toggle whose content must print in full: the returned
 * `expanded` is forced true while printing. Use this for any new collapsible, so it cannot
 * silently truncate the export.
 */
export function usePrintExpandable(): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [expanded, setExpanded] = useState(false);
  const printing = usePrinting();
  return [expanded || printing, setExpanded];
}
