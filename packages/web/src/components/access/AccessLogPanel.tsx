import React, { useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { FileAccess, UrlAccess, SessionAccessLog } from '../../lib/types.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const OPERATION_COLORS: Record<string, string> = {
  read: '#a78bfa',
  wrote: '#3fb950',
  edited: '#d29922',
  deleted: '#f85149',
};

const OPERATION_LABELS: Record<string, string> = {
  read: 'Read',
  wrote: 'Wrote',
  edited: 'Edited',
  deleted: 'Deleted',
};

interface FileGroupProps {
  operation: string;
  files: FileAccess[];
  onClickEvent: (eventId: string) => void;
}

function FileGroup({ operation, files, onClickEvent }: FileGroupProps) {
  const color = OPERATION_COLORS[operation] ?? '#8b949e';
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
          {OPERATION_LABELS[operation] ?? operation}
        </span>
        <span className="text-[10px] text-[#484f58]">({files.length})</span>
      </div>
      <div className="space-y-0.5">
        {files.map((f, i) => (
          <div key={`${f.path}-${i}`} className="flex items-center gap-2 text-xs group">
            <button
              onClick={() => onClickEvent(f.eventId)}
              className="font-mono text-[#8b949e] hover:text-[#e6edf3] truncate text-left transition-colors"
              title={f.path}
            >
              {f.path}
            </button>
            <span className="text-[10px] text-[#484f58] shrink-0">{f.toolName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface HostGroupProps {
  hostname: string;
  urls: UrlAccess[];
  onClickEvent: (eventId: string) => void;
}

function HostGroup({ hostname, urls, onClickEvent }: HostGroupProps) {
  const totalBytesIn = urls.reduce((sum, u) => sum + (u.bytesIn ?? 0), 0);
  const totalBytesOut = urls.reduce((sum, u) => sum + (u.bytesOut ?? 0), 0);

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-semibold text-[#58a6ff]">{hostname}</span>
        {(totalBytesIn > 0 || totalBytesOut > 0) && (
          <span className="text-[10px] text-[#484f58]">
            {totalBytesIn > 0 && `${formatBytes(totalBytesIn)} in`}
            {totalBytesIn > 0 && totalBytesOut > 0 && ' / '}
            {totalBytesOut > 0 && `${formatBytes(totalBytesOut)} out`}
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {urls.map((u, i) => (
          <div key={`${u.url}-${i}`} className="flex items-center gap-2 text-xs">
            <button
              onClick={() => onClickEvent(u.eventId)}
              className="font-mono text-[#8b949e] hover:text-[#e6edf3] truncate text-left transition-colors"
              title={u.url}
            >
              {u.url.length > 80 ? u.url.slice(0, 80) + '...' : u.url}
            </button>
            <span className="text-[10px] text-[#484f58] shrink-0">{u.toolName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface AccessLogContentProps {
  data: SessionAccessLog;
  onClickEvent: (eventId: string) => void;
}

function AccessLogContent({ data, onClickEvent }: AccessLogContentProps) {
  const filesByOp = useMemo(() => {
    const groups: Record<string, FileAccess[]> = {};
    for (const f of data.files) {
      (groups[f.operation] ??= []).push(f);
    }
    // Deduplicate: unique path per operation
    for (const op of Object.keys(groups)) {
      const seen = new Set<string>();
      groups[op] = groups[op].filter(f => {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      });
    }
    return groups;
  }, [data.files]);

  const urlsByHost = useMemo(() => {
    const groups: Record<string, UrlAccess[]> = {};
    for (const u of data.urls) {
      (groups[u.hostname] ??= []).push(u);
    }
    return groups;
  }, [data.urls]);

  const hasFiles = data.files.length > 0;
  const hasUrls = data.urls.length > 0;

  if (!hasFiles && !hasUrls) {
    return (
      <div className="flex items-center justify-center h-32 text-[#484f58] text-xs">
        No file or URL access recorded for this session
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasFiles && (
        <div>
          <h3 className="text-xs font-semibold text-[#e6edf3] mb-2 flex items-center gap-2">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Files ({data.files.length})
          </h3>
          {['read', 'wrote', 'edited', 'deleted'].map(op =>
            filesByOp[op] ? <FileGroup key={op} operation={op} files={filesByOp[op]} onClickEvent={onClickEvent} /> : null
          )}
        </div>
      )}
      {hasUrls && (
        <div>
          <h3 className="text-xs font-semibold text-[#e6edf3] mb-2 flex items-center gap-2">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            Remote Services ({Object.keys(urlsByHost).length})
          </h3>
          {Object.entries(urlsByHost)
            .sort(([, a], [, b]) => b.length - a.length)
            .map(([hostname, urls]) => (
              <HostGroup key={hostname} hostname={hostname} urls={urls} onClickEvent={onClickEvent} />
            ))}
        </div>
      )}
    </div>
  );
}

export function AccessLogPanel() {
  const { accessLogOpen, accessLogData, setAccessLogOpen, setSelectedEvent } = useSessionStore((s) => ({
    accessLogOpen: s.accessLogOpen,
    accessLogData: s.accessLogData,
    setAccessLogOpen: s.setAccessLogOpen,
    setSelectedEvent: s.setSelectedEvent,
  }));

  if (!accessLogOpen || !accessLogData) return null;

  const handleClickEvent = (eventId: string) => {
    setAccessLogOpen(false);
    setSelectedEvent(eventId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setAccessLogOpen(false)}>
      <div
        className="bg-[#0d1117] border border-[#30363d] rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d]">
          <h2 className="text-sm font-semibold text-[#e6edf3] flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Access Log
          </h2>
          <button
            onClick={() => setAccessLogOpen(false)}
            className="text-[#8b949e] hover:text-[#e6edf3] transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <AccessLogContent data={accessLogData} onClickEvent={handleClickEvent} />
        </div>
      </div>
    </div>
  );
}
