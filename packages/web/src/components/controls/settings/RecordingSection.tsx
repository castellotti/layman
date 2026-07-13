import React, { useCallback, useState } from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, SectionIntro, ToggleRow, CustomRow } from './primitives.js';
import { RecoveryDialog, ImportDialog, PurgeDialog } from './RecordingDialogs.js';

interface PiiCategory {
  id: string;
  label: string;
  description: string;
  group: 'direct' | 'indirect' | 'special';
  detected: boolean;
}

const PII_CATEGORIES: PiiCategory[] = [
  { id: 'email', label: 'Email addresses', description: 'Business or personal email addresses', group: 'direct', detected: true },
  { id: 'phone', label: 'Phone numbers', description: 'Telephone numbers in international or local formats', group: 'direct', detected: true },
  { id: 'ipv4', label: 'IPv4 addresses', description: 'Internet Protocol version 4 addresses', group: 'direct', detected: true },
  { id: 'ipv6', label: 'IPv6 addresses', description: 'Internet Protocol version 6 addresses', group: 'direct', detected: true },
  { id: 'mac', label: 'MAC addresses', description: 'Hardware/network interface identifiers', group: 'direct', detected: true },
  { id: 'ssn', label: 'Social security / tax numbers', description: 'National identification, social security, or tax ID numbers', group: 'direct', detected: true },
  { id: 'credit_card', label: 'Credit card numbers', description: 'Payment card numbers (Visa, Mastercard, Amex, etc.)', group: 'direct', detected: true },
  { id: 'iban', label: 'Bank account / IBAN numbers', description: 'International Bank Account Numbers and similar identifiers', group: 'direct', detected: true },
  { id: 'passport', label: 'Passport numbers', description: 'Government-issued passport document numbers', group: 'direct', detected: true },
  { id: 'drivers_license', label: "Driver's license numbers", description: "Driver's license or permit identifiers", group: 'direct', detected: true },
  { id: 'api_key', label: 'API keys', description: 'Provider API keys including Anthropic (sk-ant-) and OpenAI (sk-) formats', group: 'direct', detected: true },
  { id: 'access_token', label: 'Access tokens', description: 'GitHub tokens (ghp_, github_pat_, gho_, ghu_, ghs_, ghr_) and other bearer tokens', group: 'direct', detected: true },
  { id: 'device_id', label: 'Device identifiers', description: 'Apple iOS UDIDs, IDFAs, Android device IDs, and advertising IDs', group: 'direct', detected: true },
  { id: 'secret', label: 'Passwords / secrets / private keys', description: 'Credentials, passwords, private keys, and JWTs', group: 'direct', detected: true },
  { id: 'user_path', label: 'User / home directory paths', description: 'Local filesystem paths that reveal the OS username (e.g. /Users/alice, C:\\Users\\alice) — replaced with ~', group: 'direct', detected: true },
  { id: 'name', label: 'Personal names', description: 'First name, last name, full name of natural persons', group: 'indirect', detected: false },
  { id: 'postal_address', label: 'Postal addresses', description: 'Street addresses, ZIP/postal codes, city, country', group: 'indirect', detected: false },
  { id: 'user_id', label: 'User / customer / supplier IDs', description: 'System-specific identifiers that map to a natural person', group: 'indirect', detected: false },
  { id: 'biometric', label: 'Biometric data', description: 'Fingerprints, facial recognition data, voice prints', group: 'indirect', detected: false },
  { id: 'geolocation', label: 'Geo-location data', description: 'GPS coordinates or location tracking information', group: 'indirect', detected: false },
  { id: 'dob', label: 'Date of birth', description: 'Birth date that can contribute to identification', group: 'indirect', detected: false },
  { id: 'racial_ethnic', label: 'Racial or ethnic origin', description: 'Data revealing racial or ethnic background', group: 'special', detected: false },
  { id: 'political', label: 'Political opinions', description: 'Political party membership or beliefs', group: 'special', detected: false },
  { id: 'religious', label: 'Religious or philosophical beliefs', description: 'Faith, religious membership, or philosophical convictions', group: 'special', detected: false },
  { id: 'trade_union', label: 'Trade-union membership', description: 'Membership in trade unions or labor organizations', group: 'special', detected: false },
  { id: 'health', label: 'Health / medical data', description: 'Medical records, health conditions, prescriptions', group: 'special', detected: false },
  { id: 'sexual_orientation', label: 'Sexual orientation', description: 'Data concerning sex life or sexual orientation', group: 'special', detected: false },
  { id: 'criminal', label: 'Criminal records', description: 'Criminal proceedings, convictions, or involvement', group: 'special', detected: false },
];

const PII_GROUP_LABELS: Record<string, string> = {
  direct: 'Direct identifiers (auto-detected)',
  indirect: 'Indirect identifiers (reference)',
  special: 'Special categories (reference)',
};

type ImportResult = {
  discovered: number;
  enriched: number;
  totalEvents: number;
  skipped: number;
  errors: number;
  sessions: Array<{
    sessionId: string; cwd: string; startedAt: number; lastSeen: number;
    eventCount: number; toolCallCount: number; userPromptCount: number;
    status: 'discovered' | 'enriched' | 'skipped';
  }>;
};

export function RecordingSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const updateConfig = (updates: Partial<LaymanConfig>) => onSend({ type: 'config:update', config: updates });

  const [piiCriteriaOpen, setPiiCriteriaOpen] = useState(false);

  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [recoveryScanState, setRecoveryScanState] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [recoveryScanCount, setRecoveryScanCount] = useState<number | null>(null);
  const [recoveryScanSessionCount, setRecoveryScanSessionCount] = useState<number | null>(null);

  const [purgeState, setPurgeState] = useState<'idle' | 'scanning' | 'confirming' | 'purging' | 'done' | 'error'>('idle');
  const [scanResult, setScanResult] = useState<{ categories: { name: string; key: string; count: number }[]; total: number } | null>(null);
  const [purgeResult, setPurgeResult] = useState<{ redacted: number } | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importState, setImportState] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const handlePurgeScan = useCallback(async () => {
    setPurgeState('scanning');
    setPurgeError(null);
    try {
      const res = await fetch('/api/pii-purge/scan', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { categories: { name: string; key: string; count: number }[]; total: number };
      setScanResult(result);
      if (result.total === 0) {
        setPurgeResult({ redacted: 0 });
        setPurgeState('done');
      } else {
        setPurgeState('confirming');
      }
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : String(err));
      setPurgeState('error');
    }
  }, []);

  const handlePurgeExecute = useCallback(async () => {
    setPurgeState('purging');
    try {
      const res = await fetch('/api/pii-purge/execute', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { redacted: number };
      setPurgeResult(result);
      setPurgeState('done');
      localStorage.removeItem('layman:searchHistory');
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : String(err));
      setPurgeState('error');
    }
  }, []);

  const handlePurgeClose = useCallback(() => {
    setPurgeState('idle');
    setScanResult(null);
    setPurgeResult(null);
    setPurgeError(null);
  }, []);

  return (
    <>
      <SectionTitle>Recording &amp; import</SectionTitle>
      <SectionIntro>
        Record all Claude Code sessions to <code>~/.claude/layman.db</code>. Disabled by default.
        Bookmarked sessions survive container restarts.
      </SectionIntro>

      <ToggleRow
        label="Enable session recording"
        checked={config.sessionRecording}
        onChange={() => updateConfig({ sessionRecording: !config.sessionRecording })}
      />

      <ToggleRow
        label="Enable recording recovery"
        desc="On startup, scan recent transcripts for events missing from the record and fill the gaps"
        checked={config.recordingRecovery}
        onChange={() => {
          if (!config.recordingRecovery) setRecoveryDialogOpen(true);
          else updateConfig({ recordingRecovery: false });
        }}
      />

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>Import session history</span>
          <button
            onClick={() => setImportDialogOpen(true)}
            style={{ padding: '4px 10px', fontSize: 10.5, fontWeight: 500, borderRadius: 5, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', color: 'var(--text)', cursor: 'pointer' }}
          >
            Scan
          </button>
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Discover Claude Code sessions from transcripts not monitored live and import them into history.
        </span>
      </CustomRow>

      <ToggleRow
        label="Auto-import on startup"
        checked={config.historyImport}
        onChange={() => updateConfig({ historyImport: !config.historyImport })}
      />

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            onClick={() => setPiiCriteriaOpen(!piiCriteriaOpen)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <span style={{ fontSize: 10, transform: piiCriteriaOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.1s', display: 'inline-block' }}>▶</span>
            PII filter
          </button>
          <MiniToggle checked={config.piiFilter} onClick={() => updateConfig({ piiFilter: !config.piiFilter })} />
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Redact personally identifiable information from logged events. Click the label to see what is filtered.
        </span>

        {piiCriteriaOpen && (
          <div style={{ marginTop: 4, padding: 8, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 6, maxHeight: 256, overflowY: 'auto' }}>
            {(['direct', 'indirect', 'special'] as const).map((group) => (
              <div key={group} style={{ marginBottom: 8 }}>
                <h4 style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 4px' }}>
                  {PII_GROUP_LABELS[group]}
                </h4>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {PII_CATEGORIES.filter((c) => c.group === group).map((cat) => (
                    <li key={cat.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 10.5 }}>
                      <span style={{ marginTop: 2, flexShrink: 0, color: cat.detected ? 'var(--ok)' : 'var(--text-faint)' }}>{cat.detected ? '●' : '○'}</span>
                      <span style={{ color: 'var(--text)' }}>
                        {cat.label}
                        <span style={{ color: 'var(--text-faint)', marginLeft: 4 }}>— {cat.description}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p style={{ fontSize: 10.5, color: 'var(--text-faint)', margin: 0, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
              <span style={{ color: 'var(--ok)' }}>●</span> Auto-detected via pattern matching
              <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>○</span> Listed for awareness
            </p>
          </div>
        )}
      </CustomRow>

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Scan stored sessions and bookmarks for PII and redact all matches.
          </span>
          <button
            onClick={() => void handlePurgeScan()}
            disabled={purgeState === 'scanning' || purgeState === 'purging'}
            style={{ flexShrink: 0, padding: '6px 12px', fontSize: 11, fontWeight: 500, borderRadius: 5, background: 'rgba(240,86,74,0.12)', border: '1px solid var(--error)', color: 'var(--error)', cursor: 'pointer', opacity: purgeState === 'scanning' || purgeState === 'purging' ? 0.5 : 1 }}
          >
            {purgeState === 'scanning' ? 'Scanning…' : 'Purge all PII'}
          </button>
        </div>
      </CustomRow>

      {recoveryDialogOpen && (
        <RecoveryDialog
          scanState={recoveryScanState}
          scanCount={recoveryScanCount}
          scanSessionCount={recoveryScanSessionCount}
          onNotNow={() => {
            updateConfig({ recordingRecovery: true });
            setRecoveryDialogOpen(false);
          }}
          onScanNow={() => {
            updateConfig({ recordingRecovery: true });
            setRecoveryScanState('scanning');
            void (async () => {
              try {
                const res = await fetch('/api/recovery/scan', { method: 'POST' });
                const data = await res.json() as { events: number; sessions: number };
                setRecoveryScanCount(data.events);
                setRecoveryScanSessionCount(data.sessions);
              } catch {
                setRecoveryScanCount(0);
                setRecoveryScanSessionCount(0);
              }
              setRecoveryScanState('done');
            })();
          }}
          onDone={() => {
            setRecoveryDialogOpen(false);
            setRecoveryScanState('idle');
            setRecoveryScanCount(null);
            setRecoveryScanSessionCount(null);
          }}
          onDismiss={() => setRecoveryDialogOpen(false)}
        />
      )}

      {importDialogOpen && (
        <ImportDialog
          state={importState}
          result={importResult}
          error={importError}
          onScanNow={() => {
            void (async () => {
              setImportState('scanning');
              setImportError(null);
              try {
                const res = await fetch('/api/import/history', { method: 'POST' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                setImportResult(data as ImportResult);
                setImportState('done');
              } catch (err) {
                setImportError(err instanceof Error ? err.message : String(err));
                setImportState('error');
              }
            })();
          }}
          onClose={() => {
            if (importState === 'scanning') return;
            setImportDialogOpen(false);
            setImportState('idle');
            setImportResult(null);
            setImportError(null);
          }}
        />
      )}

      {(purgeState === 'confirming' || purgeState === 'purging' || purgeState === 'done' || purgeState === 'error') && (
        <PurgeDialog
          state={purgeState}
          scanResult={scanResult}
          result={purgeResult}
          error={purgeError}
          onExecute={() => void handlePurgeExecute()}
          onClose={handlePurgeClose}
        />
      )}
    </>
  );
}

function MiniToggle({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 30, height: 16, borderRadius: 8,
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: checked ? 'var(--bg-selected)' : 'var(--bg-card)',
        position: 'relative', cursor: 'pointer', padding: 0, flexShrink: 0, boxSizing: 'border-box',
      }}
    >
      <span style={{
        position: 'absolute', top: 1.5, left: checked ? 15 : 1.5, width: 11, height: 11, borderRadius: '50%',
        background: checked ? 'var(--accent)' : 'var(--text-faint)', transition: 'left 0.15s',
      }} />
    </button>
  );
}
