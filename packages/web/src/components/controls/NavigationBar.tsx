import React, { useEffect, useRef, useState } from 'react';
import { SearchInput, FilterChip, LiveChip } from '../primitives/index.js';

interface NavigationBarProps {
  // Search
  searchQuery: string;
  onSearchChange: (q: string) => void;
  // Filter chips
  promptsOnly: boolean;
  requestsOnly: boolean;
  responsesOnly: boolean;
  onTogglePromptsOnly: () => void;
  onToggleRequestsOnly: () => void;
  onToggleResponsesOnly: () => void;
  onClearFilters: () => void;
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
  // Expand/collapse-all toggle for the Logs single-line rows (§1.4)
  expandToggleLabel?: string;
  onExpandToggle?: () => void;
}

export function NavigationBar({
  searchQuery,
  onSearchChange,
  promptsOnly,
  requestsOnly,
  responsesOnly,
  onTogglePromptsOnly,
  onToggleRequestsOnly,
  onToggleResponsesOnly,
  onClearFilters,
  followLatest,
  archived = false,
  archivedDate,
  onAccessLog,
  onPrint,
  onBookmark,
  isBookmarked,
  defaultBookmarkName = '',
  expandToggleLabel,
  onExpandToggle,
}: NavigationBarProps) {
  const [showBookmarkInput, setShowBookmarkInput] = useState(false);
  const [bookmarkName, setBookmarkName] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Global ⌘K / Ctrl+K focuses the search field
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const anyFilterActive = promptsOnly || requestsOnly || responsesOnly;

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
        inputRef={searchInputRef}
        value={searchQuery}
        onChange={onSearchChange}
        flex={1}
        minWidth={240}
        maxWidth={560}
        padding="8px 12px"
        fontSize={12.5}
        placeholder="Search events   +include   −exclude"
      />

      {divider}

      {/* Filter chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <FilterChip label="Prompts" active={promptsOnly} onClick={onTogglePromptsOnly} />
        <FilterChip label="Responses" active={responsesOnly} onClick={onToggleResponsesOnly} />
        <FilterChip label="Permissions" active={requestsOnly} onClick={onToggleRequestsOnly} />
        {anyFilterActive && (
          <button
            onClick={onClearFilters}
            style={{
              padding: '4px 8px',
              fontSize: 10.5,
              fontFamily: 'var(--font-ui)',
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
              background: 'transparent',
              color: 'var(--text-faint)',
              textDecoration: 'underline',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; }}
          >
            clear
          </button>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Expand/collapse all */}
      {onExpandToggle && (
        <button
          onClick={onExpandToggle}
          title="Toggle expand/collapse for all rows (E)"
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-muted)',
            background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 4,
            padding: '2px 8px', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'var(--text-faint)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
        >
          {expandToggleLabel}
        </button>
      )}

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
