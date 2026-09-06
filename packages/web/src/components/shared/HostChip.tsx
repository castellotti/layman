import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { hostAccent, isRemoteHost } from '../../lib/host.js';

interface HostChipProps {
  hostId?: string;
  /** Optional explicit name; otherwise resolved from the known hosts table. */
  hostName?: string;
  className?: string;
}

/**
 * A small mono-font pill naming the origin host of a session or curation row
 * (docs/planning/multi-host-sync.md §8.2). Renders nothing for the local host,
 * so single-machine installs look exactly as they did before. The 2px left
 * border is a deterministic per-host accent, so the same host is recognisable
 * across views.
 */
export function HostChip({ hostId, hostName, className }: HostChipProps) {
  const config = useSessionStore((s) => s.config);
  const hosts = useSessionStore((s) => s.syncHosts);
  const localHostId = config?.sync?.hostId ?? '';

  if (!isRemoteHost(hostId, localHostId)) return null;

  const name = hostName ?? hosts.find((h) => h.hostId === hostId)?.name ?? hostId!.slice(0, 8);
  const accent = `var(${hostAccent(hostId!)})`;

  return (
    <span
      className={className}
      title={`Recorded on ${name}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        maxWidth: 140,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 10,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 4,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderLeft: `2px solid ${accent}`,
        color: 'var(--text-muted)',
      }}
    >
      {name}
    </span>
  );
}
