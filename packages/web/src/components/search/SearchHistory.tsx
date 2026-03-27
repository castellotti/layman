import React from 'react';
import { useSearchStore } from '../../stores/searchStore.js';

interface SearchHistoryProps {
  onClose: () => void;
}

export function SearchHistory({ onClose }: SearchHistoryProps) {
  const { searchHistory, restoreHistoryEntry, executeSearch, clearHistory, query } = useSearchStore();

  // Filter by current query prefix
  const filtered = query.trim()
    ? searchHistory.filter((h) => h.query.toLowerCase().startsWith(query.toLowerCase()))
    : searchHistory;

  if (filtered.length === 0) return null;

  return (
    <div className="absolute left-3 right-3 top-full mt-1 z-10 bg-[#161b22] border border-[#30363d] rounded-md shadow-lg max-h-48 overflow-y-auto">
      {filtered.map((entry, i) => (
        <button
          key={`${entry.query}-${entry.timestamp}-${i}`}
          onClick={() => {
            restoreHistoryEntry(entry);
            void executeSearch();
            onClose();
          }}
          className="w-full text-left px-3 py-1.5 hover:bg-[#21262d] transition-colors flex items-center justify-between gap-2"
        >
          <span className="text-xs text-[#e6edf3] truncate">{entry.query}</span>
          <span className="text-[9px] text-[#484f58] shrink-0">
            {entry.scope === 'all' ? 'All' : entry.scope === 'current' ? 'Current' : entry.scope.slice(0, 6)}
            {' '}
            {new Date(entry.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        </button>
      ))}
      <button
        onClick={() => { clearHistory(); onClose(); }}
        className="w-full text-center px-3 py-1.5 text-[10px] text-[#484f58] hover:text-[#f85149] hover:bg-[#21262d] transition-colors border-t border-[#30363d]"
      >
        Clear history
      </button>
    </div>
  );
}
