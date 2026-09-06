/**
 * Pure helpers for multi-host attribution (docs/planning/multi-host-sync.md §8.2).
 * Kept side-effect-free so they can be unit-tested without a DOM.
 */

/** The six semantic colour variables a host chip's accent is drawn from. */
export const HOST_ACCENT_VARS = ['--info', '--agent', '--warn', '--ok', '--accent', '--error'] as const;
export type HostAccentVar = (typeof HOST_ACCENT_VARS)[number];

/** Deterministic accent for a host id, so the same host looks the same everywhere. */
export function hostAccent(hostId: string): HostAccentVar {
  let hash = 0;
  for (let i = 0; i < hostId.length; i++) {
    hash = (hash * 31 + hostId.charCodeAt(i)) >>> 0;
  }
  return HOST_ACCENT_VARS[hash % HOST_ACCENT_VARS.length];
}

/**
 * Is a piece of curation (folder/bookmark/highlight) editable on this host?
 *
 * A row with no `hostId` predates sync and is local; a row whose `hostId`
 * matches the local host is ours; anything else belongs to another host and is
 * read-only here (§3.6).
 */
export function isEditableCuration(row: { hostId?: string }, localHostId: string): boolean {
  return !row.hostId || row.hostId === localHostId;
}

/** True when a row (session, curation) originates on another host. */
export function isRemoteHost(hostId: string | undefined, localHostId: string): boolean {
  return !!hostId && hostId !== localHostId;
}

/**
 * The label to show for a host id: empty for the local host (single-machine
 * installs then render nothing), the host name otherwise.
 */
export function hostLabel(
  hostId: string | undefined,
  localHostId: string,
  nameById: (id: string) => string | undefined,
): string {
  if (!isRemoteHost(hostId, localHostId)) return '';
  return nameById(hostId!) ?? hostId!.slice(0, 8);
}

/** Human-readable byte size for the hosts stats table ("1.2 MB"). */
export function formatContentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
