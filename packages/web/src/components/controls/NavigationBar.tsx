import React, { useState } from 'react';
import { SearchInput, FilterChip, LiveChip } from '../primitives/index.js';

interface NavigationBarProps {
  // Search
  searchQuery: string;
  onSearchChange: (q: string) => void;
  // Filter chips
  promptsOnly: boolean;
  toolsOnly: boolean;
  requestsOnly: boolean;
  agentsOnly: boolean;
  riskyOnly: boolean;
  onTogglePromptsOnly: () => void;
  onToggleToolsOnly: () => void;
  onToggleRequestsOnly: () => void;
  onToggleAgentsOnly: () => void;
  onToggleRiskyOnly: () => void;
  // Live state
  followLatest: boolean;
  archived?: boolean;
  archivedDate?: string;
  // Actions
  onAccessLog?: () => void;
  onPrint?: () => void;
  onBookmark?: (name: string) => void;
  isBookmarked?: boolean;
  defaultBookmarkName?: string;
}

export function NavigationBar({
  searchQuery,
  onSearchChange,
  promptsOnly,
  toolsOnly,
  requestsOnly,
  agentsOnly,
  riskyOnly,
  onTogglePromptsOnly,
  onToggleToolsOnly,
  onToggleRequestsOnly,
  onToggleAgentsOnly,
  onToggleRiskyOnly,
  followLatest,
  archived = false,
  archivedDate,
  onAccessLog,
  onPrint,
  onBookmark,
  isBookmarked,
  defaultBookmarkName = '',
}: NavigationBarProps) {
  const [showBookmarkInput, setShowBookmarkInput] = useState(false);
  const [bookmarkName, setBookmarkName] = useState('');

  const handleBookmarkClick = () => {
    setBookmarkName(defaultBookmarkName);
    setShowBookmarkInput(true);
  };

  const handleBookmarkSubmit = () => {
    if (onBookmark) onBookmark(bookmarkName);
    setShowBookmarkInput(false);
    setBookmarkName('');
  };

  const divider = (
    <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0 }} />
  );

  return (
    <div
      data-print-hide
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 12px',
        background: 'var(--bg-raised)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}
    >
      {/* Search */}
      <SearchInput
        value={searchQuery}
        onChange={onSearchChange}
        width={180}
        placeholder="Search  +include  −exclude"
      />

      {divider}

      {/* Filter chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <FilterChip label="Prompts" active={promptsOnly} onClick={onTogglePromptsOnly} />
        <FilterChip label="Tools" active={toolsOnly} onClick={onToggleToolsOnly} />
        <FilterChip label="Permissions" active={requestsOnly} onClick={onToggleRequestsOnly} />
        <FilterChip label="Agents" active={agentsOnly} onClick={onToggleAgentsOnly} />
        <FilterChip label="Risk≥med" active={riskyOnly} onClick={onToggleRiskyOnly} riskOutline />
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Live chip */}
      <LiveChip state={archived ? 'archived' : (followLatest ? 'live' : 'paused')} archivedDate={archivedDate} />

      {/* Access Log */}
      {onAccessLog && (
        <>
          {divider}
          <button
            onClick={onAccessLog}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-ui)',
            }}
            title="Access Log"
          >
            <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Log
          </button>
        </>
      )}

      {/* Bookmark */}
      {onBookmark && !isBookmarked && (
        <>
          {divider}
          {showBookmarkInput ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                autoFocus
                type="text"
                value={bookmarkName}
                onChange={(e) => setBookmarkName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleBookmarkSubmit();
                  if (e.key === 'Escape') { setShowBookmarkInput(false); setBookmarkName(''); }
                }}
                placeholder="Bookmark name…"
                style={{
                  fontSize: 11, fontFamily: 'var(--font-ui)',
                  background: 'var(--bg-card)', border: '1px solid var(--accent)',
                  borderRadius: 5, padding: '2px 8px', color: 'var(--text)',
                  outline: 'none', width: 140,
                }}
              />
              <button onClick={handleBookmarkSubmit} style={{ color: 'var(--ok)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}>✓</button>
              <button onClick={() => { setShowBookmarkInput(false); setBookmarkName(''); }} style={{ color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
          ) : (
            <button
              onClick={handleBookmarkClick}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-ui)',
              }}
              title="Bookmark current session"
            >
              <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              Bookmark
            </button>
          )}
        </>
      )}

      {/* Export */}
      {onPrint && (
        <>
          {divider}
          <button
            onClick={onPrint}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-ui)',
            }}
            title="Export to PDF"
          >
            <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Export
          </button>
        </>
      )}
    </div>
  );
}
