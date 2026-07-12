import React from 'react';
import { sessionDisplayName } from '../../../lib/session-state.js';

const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const scrimStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)' };
const cardStyle: React.CSSProperties = { position: 'relative', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 8, boxShadow: '0 24px 60px rgba(0,0,0,0.5)', padding: 20 };
const btnStyle: React.CSSProperties = { padding: '6px 12px', fontSize: 11, borderRadius: 5, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', color: 'var(--text)', cursor: 'pointer' };
const btnPrimaryStyle: React.CSSProperties = { padding: '6px 12px', fontSize: 11, fontWeight: 500, borderRadius: 5, background: 'var(--ok)', color: 'var(--text-on-fill)', border: 'none', cursor: 'pointer' };
const btnDangerStyle: React.CSSProperties = { padding: '6px 12px', fontSize: 11, fontWeight: 500, borderRadius: 5, background: 'var(--error)', color: 'var(--text-on-fill)', border: 'none', cursor: 'pointer' };

export function RecoveryDialog({
  scanState, scanCount, scanSessionCount, onScanNow, onNotNow, onDone, onDismiss,
}: {
  scanState: 'idle' | 'scanning' | 'done';
  scanCount: number | null;
  scanSessionCount: number | null;
  onScanNow: () => void;
  onNotNow: () => void;
  onDone: () => void;
  onDismiss: () => void;
}) {
  return (
    <div style={overlayStyle}>
      <div style={scrimStyle} onClick={scanState !== 'scanning' ? onDismiss : undefined} />
      <div style={{ ...cardStyle, width: 320 }}>
        {scanState === 'idle' && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>Enable recording recovery</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
              Run an update check now? Layman will compare all sessions in history against their
              available transcript logs and fill any gaps. Subsequent startup scans will be faster
              since already-checked events will be skipped.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onNotNow} style={btnStyle}>Not now</button>
              <button onClick={onScanNow} style={btnPrimaryStyle}>Scan now</button>
            </div>
          </>
        )}
        {scanState === 'scanning' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
            <Spinner />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>Scanning session transcripts…</p>
          </div>
        )}
        {scanState === 'done' && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>Scan complete</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
              {scanCount === 0
                ? 'No missing events found — all recorded sessions are up to date.'
                : `Recovered ${scanCount} missing event${scanCount === 1 ? '' : 's'} across ${scanSessionCount} session${scanSessionCount === 1 ? '' : 's'}.`}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onDone} style={btnStyle}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div
      className="animate-spin"
      style={{ width: 16, height: 16, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', flexShrink: 0 }}
    />
  );
}

interface ImportedSession {
  sessionId: string;
  cwd: string;
  startedAt: number;
  lastSeen: number;
  eventCount: number;
  toolCallCount: number;
  userPromptCount: number;
  status: 'discovered' | 'enriched' | 'skipped';
}

export function ImportDialog({
  state, result, error, onScanNow, onClose,
}: {
  state: 'idle' | 'scanning' | 'done' | 'error';
  result: { discovered: number; enriched: number; totalEvents: number; skipped: number; errors: number; sessions: ImportedSession[] } | null;
  error: string | null;
  onScanNow: () => void;
  onClose: () => void;
}) {
  return (
    <div style={overlayStyle}>
      <div style={scrimStyle} onClick={state !== 'scanning' ? onClose : undefined} />
      <div style={{ ...cardStyle, width: 420, maxHeight: '80vh', overflowY: 'auto' }}>
        {state === 'idle' && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>Import session history</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
              Scan Claude Code transcript files for sessions that were not monitored by Layman
              and import them into the history database. Existing live-recorded sessions will be
              enriched with any missing events without modifying their data.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onClose} style={btnStyle}>Cancel</button>
              <button onClick={onScanNow} style={btnPrimaryStyle}>Scan now</button>
            </div>
          </>
        )}
        {state === 'scanning' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
            <Spinner />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>Scanning transcript files…</p>
          </div>
        )}
        {state === 'done' && result && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>Import complete</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
              {result.discovered === 0 && result.enriched === 0
                ? 'No new sessions found — all available transcripts are already in the database.'
                : `Discovered ${result.discovered} new session${result.discovered === 1 ? '' : 's'}, enriched ${result.enriched} existing session${result.enriched === 1 ? '' : 's'} (${result.totalEvents.toLocaleString()} events total).`}
              {result.errors > 0 && (
                <span style={{ color: 'var(--error)' }}> {result.errors} file{result.errors === 1 ? '' : 's'} failed to parse.</span>
              )}
            </p>
            {result.sessions.length > 0 && (
              <div style={{ maxHeight: 192, overflowY: 'auto', border: '1px solid var(--border-strong)', borderRadius: 6, marginBottom: 12 }}>
                <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-raised)' }}>
                    <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-strong)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Project</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Date</th>
                      <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Events</th>
                      <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Tools</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 500 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.sessions.map((s) => (
                      <tr key={s.sessionId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '4px 8px', color: 'var(--text)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.cwd}>
                          {sessionDisplayName(undefined, s.cwd, s.sessionId)}
                        </td>
                        <td style={{ padding: '4px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {new Date(s.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{s.eventCount}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{s.toolCallCount}</td>
                        <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                          <span style={{ padding: '1px 6px', borderRadius: 4, color: s.status === 'discovered' ? 'var(--ok)' : 'var(--accent)', background: s.status === 'discovered' ? 'rgba(76,195,138,0.1)' : 'rgba(90,156,248,0.1)' }}>
                            {s.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 12 }}>
              Imported sessions appear in the Sessions History panel with an &ldquo;imported&rdquo; badge.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={btnStyle}>Done</button>
            </div>
          </>
        )}
        {state === 'error' && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--error)', margin: '0 0 8px' }}>Import failed</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>{error}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onClose} style={btnStyle}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PurgeDialog({
  state, scanResult, result, error, onExecute, onClose,
}: {
  state: 'confirming' | 'purging' | 'done' | 'error';
  scanResult: { categories: { name: string; key: string; count: number }[]; total: number } | null;
  result: { redacted: number } | null;
  error: string | null;
  onExecute: () => void;
  onClose: () => void;
}) {
  return (
    <div style={overlayStyle}>
      <div style={scrimStyle} onClick={state === 'purging' ? undefined : onClose} />
      <div style={{ ...cardStyle, maxWidth: 400, width: '100%' }}>
        {state === 'confirming' && scanResult && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', margin: '0 0 12px' }}>PII Scan Results</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              Found PII in {scanResult.total} {scanResult.total === 1 ? 'field' : 'fields'} across stored data:
            </p>
            <ul style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {scanResult.categories.map((cat) => (
                <li key={cat.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: 'var(--text)' }}>{cat.name}</span>
                  <span style={{ color: cat.count > 0 ? 'var(--error)' : 'var(--text-faint)', fontWeight: cat.count > 0 ? 600 : 400, fontVariantNumeric: 'tabular-nums' }}>
                    {cat.count} {cat.count === 1 ? 'field' : 'fields'}
                  </span>
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 10.5, color: 'var(--error)', marginBottom: 16 }}>
              This action cannot be undone. All matched PII will be replaced with [REDACTED].
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onClose} style={btnStyle}>Cancel</button>
              <button onClick={onExecute} style={btnDangerStyle}>Purge {scanResult.total} {scanResult.total === 1 ? 'field' : 'fields'}</button>
            </div>
          </>
        )}
        {state === 'purging' && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <p style={{ fontSize: 11, color: 'var(--text)', margin: 0 }}>Purging PII...</p>
            <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4 }}>Do not close this dialog.</p>
          </div>
        )}
        {state === 'done' && result && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ok)', margin: '0 0 8px' }}>
              {result.redacted === 0 ? 'No PII Found' : 'Purge Complete'}
            </h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
              {result.redacted === 0
                ? 'No PII was detected in the database.'
                : `Redacted ${result.redacted} ${result.redacted === 1 ? 'field' : 'fields'}. Search history has also been cleared.`}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={btnStyle}>Close</button>
            </div>
          </>
        )}
        {state === 'error' && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--error)', margin: '0 0 8px' }}>Error</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>{error}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={btnStyle}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
