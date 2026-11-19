import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getJson } from '../../../hooks/useNetTrace.js';
import { sp, rad } from '../../../lib/density.js';

/** Mirrors `BrowseResult` in `packages/server/src/routes/fs-browse.ts`. */
export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; kind: 'dir' | 'file' }[];
  requested: string;
  requestedExists: boolean;
  truncated: boolean;
  error?: string;
}

/** A name inside a listed folder, written the way the server writes paths. */
export const childPath = (dir: string, name: string): string =>
  dir === '~' ? `~/${name}` : `${dir.replace(/\/$/, '')}/${name}`;

const BTN: React.CSSProperties = {
  padding: sp('4px 10px'), fontSize: 11.5, borderRadius: rad(5), cursor: 'pointer',
  background: 'var(--bg-card)', color: 'var(--text)', border: 'var(--stroke) solid var(--border-strong)',
};

/**
 * Browse… for a path setting. The browser cannot reveal a real path, so this lists what Layman's
 * server can see (`/api/fs/browse`: names only, inside the home and Layman's data folders). In
 * `dir` mode Select takes the listed or typed folder, which may not exist yet; in `file` mode it
 * takes a chosen file with the extension `ext`.
 */
export function PathPicker({ title, mode, ext, start, onChoose, onClose }: {
  title: string;
  mode: 'dir' | 'file';
  ext?: string;
  start: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [typed, setTyped] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback((path: string) => {
    const q = new URLSearchParams({ path });
    if (mode === 'file' && ext) q.set('ext', ext);
    getJson<BrowseResult>(`/api/fs/browse?${q}`)
      .then((r) => { setListing(r); setTyped(r.requestedExists || r.requested === r.path ? r.path : path); setActive(0); setPicked(null); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [mode, ext]);

  useEffect(() => { load(start); inputRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = listing?.entries ?? [];
  const open = (i: number) => {
    const e = entries[i];
    if (!listing || !e) return;
    if (e.kind === 'dir') load(childPath(listing.path, e.name));
    else onChoose(childPath(listing.path, e.name));
  };
  const typedOk = mode === 'dir' ? typed.trim() !== '' : !!ext && typed.trim().toLowerCase().endsWith(ext.toLowerCase());
  const selection = picked ?? (typedOk ? typed.trim() : null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div
      data-print-hide
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: 'min(560px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: sp(8), padding: sp(14), background: 'var(--bg-raised)', border: 'var(--stroke) solid var(--border-strong)', borderRadius: rad(8), color: 'var(--text)' }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ display: 'flex', gap: sp(6) }}>
          <button type="button" style={{ ...BTN, opacity: listing?.parent ? 1 : 0.5 }} disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>Up</button>
          <input
            ref={inputRef}
            type="text"
            value={typed}
            aria-label="Folder path"
            spellCheck={false}
            onChange={(e) => { setTyped(e.target.value); setPicked(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(typed); } }}
            style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: sp('4px 6px'), fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: 'var(--stroke) solid var(--border-strong)', borderRadius: rad(5), color: 'var(--text)', outline: 'none' }}
          />
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Folders"
          tabIndex={0}
          data-own-arrows
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(entries.length - 1, a + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); open(active); }
          }}
          style={{ flex: 1, minHeight: 160, overflowY: 'auto', border: 'var(--stroke) solid var(--border)', borderRadius: rad(5), background: 'var(--bg-card)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
        >
          {entries.length === 0 && <div style={{ padding: sp(8), color: 'var(--text-faint)' }}>{listing ? (mode === 'file' ? 'No folders or matching files here.' : 'No folders here.') : 'Loading…'}</div>}
          {entries.map((e, i) => {
            const isPicked = picked !== null && listing !== null && picked === childPath(listing.path, e.name);
            return (
              <div
                key={e.name}
                role="option"
                aria-selected={i === active}
                data-i={i}
                onClick={() => {
                  setActive(i);
                  if (e.kind === 'dir') open(i);
                  else if (listing) { setPicked(childPath(listing.path, e.name)); setTyped(childPath(listing.path, e.name)); }
                }}
                onDoubleClick={() => { if (e.kind === 'file') open(i); }}
                style={{ padding: sp('3px 8px'), cursor: 'pointer', display: 'flex', gap: sp(6), background: isPicked ? 'var(--bg-selected)' : 'transparent', outline: i === active ? 'var(--stroke) solid var(--accent)' : 'none', outlineOffset: -1 }}
              >
                <span aria-hidden="true">{e.kind === 'dir' ? '▸' : ' '}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
              </div>
            );
          })}
        </div>
        {listing?.truncated && <div style={{ fontSize: 10.5, color: 'var(--warn)' }}>Showing the first 1000.</div>}
        {(error || listing?.error) && <div role="alert" style={{ fontSize: 10.5, color: 'var(--warn)' }}>{error ?? listing?.error}</div>}
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Folders Layman can see. In Docker, only the mounted folders appear.</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: sp(8) }}>
          <button type="button" style={BTN} onClick={onClose}>Cancel</button>
          <button
            type="button"
            style={{ ...BTN, opacity: selection ? 1 : 0.5 }}
            disabled={!selection}
            onClick={() => selection && onChoose(selection)}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}
