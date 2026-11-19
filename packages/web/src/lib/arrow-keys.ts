/**
 * The one rule for when a global arrow-key handler may act. A component that uses arrows while
 * it has focus marks itself `data-own-arrows`.
 */
import { useSessionStore } from '../stores/sessionStore.js';

const OWN = '[data-own-arrows], [role=slider], [role=separator], [role=listbox], [role=grid], [role=tree], [role=menu], [role=radiogroup]';

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (sel: string) => unknown;
}

export function arrowKeysFree(
  e: Pick<KeyboardEvent, 'defaultPrevented' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>,
  modalOpen: () => boolean = defaultModalOpen,
): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  const t = e.target as TargetLike | null;
  const tag = t?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return false;
  if (t?.closest?.(OWN)) return false;
  return !modalOpen();
}

function defaultModalOpen(): boolean {
  if (useSessionStore.getState().settingsOpen) return true;
  return typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"]');
}
