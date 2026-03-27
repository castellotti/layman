import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchStore } from '../../stores/searchStore.js';
import type { SearchField, SearchScope } from '../../stores/searchStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { SearchHistory } from './SearchHistory.js';

const FIELD_LABELS: Record<SearchField, string> = {
  dataPrompt: 'Prompts',
  dataToolName: 'Tool names',
  dataToolInput: 'Tool input',
  analysisMeaning: 'Analysis',
  laymansExplanation: "Layman's",
};

interface SearchBarProps {
  /** Override the scope options with a specific session being viewed */
  viewingSessionId?: string | null;
  viewingSessionLabel?: string;
}

export function SearchBar({ viewingSessionId, viewingSessionLabel }: SearchBarProps) {
  const {
    query, setQuery, fields, toggleField, scope, setScope,
    advancedOpen, setAdvancedOpen, isSearching, executeSearch, searchError,
  } = useSearchStore();

  const { sessions, activeSessionId } = useSessionStore();
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close history dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void executeSearch();
      setHistoryOpen(false);
    } else if (e.key === 'Escape') {
      setHistoryOpen(false);
      inputRef.current?.blur();
    }
  }, [executeSearch]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setHistoryOpen(e.target.value.length > 0);
    // Debounced search
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (e.target.value.trim()) void executeSearch();
    }, 500);
  }, [setQuery, executeSearch]);

  // Build scope options
  const scopeOptions: { value: SearchScope; label: string }[] = [
    { value: 'all', label: 'All Sessions' },
  ];
  if (activeSessionId) {
    scopeOptions.push({ value: 'current', label: 'Current Session' });
  }
  if (viewingSessionId && viewingSessionId !== activeSessionId) {
    scopeOptions.push({
      value: viewingSessionId,
      label: viewingSessionLabel ? `Viewing: ${viewingSessionLabel}` : `Session ${viewingSessionId.slice(0, 6)}`,
    });
  }
  for (const s of sessions) {
    if (s.sessionId !== activeSessionId && s.sessionId !== viewingSessionId) {
      const name = s.cwd ? s.cwd.split('/').filter(Boolean).pop() ?? s.sessionId.slice(0, 8) : s.sessionId.slice(0, 8);
      scopeOptions.push({ value: s.sessionId, label: name });
    }
  }

  return (
    <div ref={containerRef} className="relative border-b border-[#30363d] px-3 py-2 space-y-2">
      {/* Main search row */}
      <div className="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="#484f58" className="shrink-0">
          <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (query.length > 0) setHistoryOpen(true); }}
          placeholder="Search sessions... (+include -exclude)"
          className="flex-1 min-w-0 px-2 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="shrink-0 px-1.5 py-1 text-[10px] bg-[#21262d] border border-[#30363d] rounded text-[#8b949e] focus:outline-none focus:border-[#58a6ff] cursor-pointer"
        >
          {scopeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className={`shrink-0 p-1 rounded transition-colors ${advancedOpen ? 'text-[#58a6ff]' : 'text-[#484f58] hover:text-[#8b949e]'}`}
          title="Advanced search options"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ transform: advancedOpen ? 'rotate(180deg)' : 'none' }}>
            <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z" />
          </svg>
        </button>
      </div>

      {/* Status indicators */}
      {isSearching && (
        <p className="text-[10px] text-[#d29922] animate-pulse">Searching...</p>
      )}
      {searchError && (
        <p className="text-[10px] text-[#f85149]">{searchError}</p>
      )}

      {/* Advanced: field toggles */}
      {advancedOpen && (
        <div className="flex flex-wrap gap-1.5">
          {(Object.entries(FIELD_LABELS) as [SearchField, string][]).map(([field, label]) => {
            const active = fields.includes(field);
            return (
              <button
                key={field}
                onClick={() => toggleField(field)}
                className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                  active
                    ? 'bg-[#21262d] border-[#58a6ff] text-[#e6edf3]'
                    : 'bg-transparent border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Search history dropdown */}
      {historyOpen && (
        <SearchHistory onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}
