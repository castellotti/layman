import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HEX_COLOR, longHex } from '../../../lib/color.js';
import {
  themeProblemsWith, TOKEN_GROUPS,
  type Overrides, type Theme, type ThemeId, type Token, type TokenMap,
} from '../../../lib/themes.js';
import { tokenColor } from '../../../lib/tokens.js';
import { CustomRow } from './primitives.js';
import { sp, rad } from '../../../lib/density.js';

type Colours = Partial<TokenMap>;

/** How long a colour must stay put before it is saved: a colour picker reports every step of a drag. */
const SAVE_DELAY_MS = 250;

/** No overrides: one object, so the memo below holds across renders. */
const NONE: Colours = {};

const sameColour = (a: string, b: string): boolean => longHex(a) === longHex(b);

/**
 * The colours of the theme showing, each replaceable. Edits show at once in the inputs and are
 * saved after a short pause; the page (and the specimen above the list) changes when the saved
 * config comes back, like any other appearance choice. A colour set back to the theme's own is
 * removed from the overrides, not stored. Rule breaks are listed, never refused: it is the
 * user's screen.
 */
export function ColourOverrides({
  theme, overrides, saved: savedConfig, onSave,
}: {
  /** The theme showing; the parent keys this component by its id. */
  theme: Theme;
  overrides: Overrides;
  /** The config's appearance as received: a new one means the server answered. */
  saved: unknown;
  onSave: (overrides: Overrides) => void;
}) {
  const saved = overrides[theme.id] ?? NONE;
  /** Edits not yet seen back in the config; null shows what is saved. */
  const [draft, setDraft] = useState<Colours | null>(null);
  const pending = useRef<{ id: ThemeId; colours: Colours; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** A save went out and no config has come back since. */
  const awaiting = useRef(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const flush = () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    awaiting.current = true;
    onSaveRef.current({ [p.id]: p.colours });
  };

  // Closing Settings (or switching theme, which remounts this) saves what is pending.
  useEffect(() => flush, []);

  // The server answered a save: show what it stored, whether or not it took the edit (another
  // tab may have saved since), so the inputs never claim colours the page is not using.
  useEffect(() => {
    if (awaiting.current && !pending.current) {
      awaiting.current = false;
      setDraft(null);
    }
  }, [savedConfig]);

  const colours = draft ?? saved;

  const setColours = (next: Colours) => {
    setDraft(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { id: theme.id, colours: next, timer: setTimeout(flush, SAVE_DELAY_MS) };
  };

  const setToken = (token: Token, value: string) => {
    const next = { ...colours };
    if (sameColour(value, theme.tokens[token])) delete next[token];
    else next[token] = value;
    setColours(next);
  };

  const problems = useMemo(() => themeProblemsWith(theme, colours), [theme, colours]);
  const changed = Object.keys(colours).length;

  return (
    <CustomRow>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: sp(8) }}>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>Colours of {theme.name}</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', flex: 1 }}>
          {changed ? `${changed} changed` : "the theme's own"} · kept for this theme only
        </span>
        {changed > 0 && (
          <button onClick={() => setColours({})} style={linkButton}>Reset all</button>
        )}
      </div>

      <Specimen />

      {problems.length > 0 ? (
        <div role="status" style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--warn)', border: `var(--stroke) solid ${tokenColor('warn', '35%')}`, background: tokenColor('warn', '8%'), borderRadius: rad(5), padding: sp('6px 9px') }}>
          <div style={{ fontWeight: 600, marginBottom: sp(2) }}>Harder to read: {problems.length} check{problems.length === 1 ? '' : 's'} fail</div>
          {problems.map((p) => <div key={p}>{p}</div>)}
        </div>
      ) : (
        <div role="status" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
          Passes the theme checks: text contrast, status colours as text, and the accent kept clear of the status colours.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: sp('10px 18px') }}>
        {TOKEN_GROUPS.map((g) => (
          <div key={g.name} style={{ display: 'flex', flexDirection: 'column', gap: sp(3) }}>
            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)', padding: sp('2px 0') }}>{g.name}</span>
            {g.tokens.map((token) => (
              <ColourRow
                key={`${theme.id}:${token}`}
                token={token}
                value={colours[token] ?? theme.tokens[token]}
                own={theme.tokens[token]}
                themeName={theme.name}
                overridden={token in colours}
                onChange={(v) => setToken(token, v)}
              />
            ))}
          </div>
        ))}
      </div>
    </CustomRow>
  );
}

const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, fontFamily: 'inherit',
  color: 'var(--info)', textDecoration: 'underline',
};

function ColourRow({
  token, value, own, themeName, overridden, onChange,
}: {
  token: Token;
  value: string;
  own: string;
  themeName: string;
  overridden: boolean;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (!HEX_COLOR.test(text)) setText(value);
    else if (!sameColour(text, value)) onChange(text);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp(6) }}>
      <input
        type="color"
        aria-label={`${token} colour`}
        value={longHex(value)}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 22, height: 18, padding: 0, border: 'var(--stroke) solid var(--border-strong)', borderRadius: rad(3), background: 'none', cursor: 'pointer', flexShrink: 0 }}
      />
      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: overridden ? 'var(--text)' : 'var(--text-muted)', fontWeight: overridden ? 600 : 400, flex: 1, minWidth: 0 }}>
        {token}
      </span>
      <input
        type="text"
        aria-label={`${token} hex`}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value.trim())}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setText(value); }}
        style={{
          width: 64, padding: sp('2px 5px'), fontSize: 10.5, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)',
          border: `var(--stroke) solid ${HEX_COLOR.test(text) ? 'var(--border-strong)' : 'var(--error)'}`, borderRadius: rad(4), color: 'var(--text)', outline: 'none',
        }}
      />
      <button
        onClick={() => onChange(own)}
        disabled={!overridden}
        title={overridden ? `Back to ${themeName}'s ${own}` : `${themeName}'s own colour`}
        aria-label={`Reset ${token}`}
        style={{ ...linkButton, textDecoration: 'none', width: 14, visibility: overridden ? 'visible' : 'hidden' }}
      >
        ↺
      </button>
    </div>
  );
}

const KINDS: readonly [Token, string][] = [
  ['info', 'info'], ['agent', 'agent'], ['thinking', 'thinking'], ['severity-major', 'major'], ['severity-minor', 'minor'],
];
const NET_LINES: readonly Token[] = ['net-tunnel', 'net-up', 'net-down', 'net-fanout'];

/** A small piece of the UI in the current colours, so an edit is seen where it matters. */
function Specimen() {
  const chip = (token: Token, label: string) => (
    <span style={{ fontSize: 9.5, fontWeight: 600, color: `var(--${token})`, border: `var(--stroke) solid ${tokenColor(token, '45%')}`, background: tokenColor(token, '12%'), borderRadius: rad(4), padding: sp('1px 6px') }}>{label}</span>
  );
  return (
    <div aria-hidden style={{ display: 'flex', gap: sp(10), padding: sp(10), background: 'var(--bg)', border: 'var(--stroke) solid var(--border)', borderRadius: rad(6) }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: sp(5), background: 'var(--bg-card)', border: 'var(--stroke) solid var(--border-strong)', borderRadius: rad(5), padding: sp('8px 10px') }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: sp(6) }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Bash</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>pnpm test</span>
          <span style={{ flex: 1 }} />
          {chip('ok', 'LOW')}{chip('warn', 'MEDIUM')}{chip('error', 'HIGH')}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-body)' }}>
          Runs the tests. <span style={{ color: 'var(--text)', borderBottom: 'var(--stroke) solid var(--accent)' }}>Body text</span> with a link underline.
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>2 min ago · faint text</span>
        <div style={{ display: 'flex', gap: sp(8), fontSize: 10.5 }}>
          {KINDS.map(([token, label]) => <span key={token} style={{ color: `var(--${token})` }}>{label}</span>)}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', fontSize: 10.5, fontFamily: 'var(--font-mono)', background: 'var(--bg-code)', border: 'var(--stroke) solid var(--border-subtle)', borderRadius: rad(5), overflow: 'hidden' }}>
        <span style={{ color: 'var(--code)', padding: sp('3px 8px') }}>const ok = run();</span>
        <span style={{ color: 'var(--diff-remove-text)', background: 'var(--diff-remove-bg)', padding: sp('1px 8px') }}>- return false;</span>
        <span style={{ color: 'var(--diff-add-text)', background: 'var(--diff-add-bg)', padding: sp('1px 8px') }}>+ return ok;</span>
        <span style={{ display: 'flex', gap: sp(6), alignItems: 'center', padding: sp('4px 8px'), background: 'var(--bg-raised)', borderTop: 'var(--stroke) solid var(--border-subtle)', marginTop: 'auto' }}>
          {NET_LINES.map((token) => <span key={token} style={{ width: 16, height: 3, background: `var(--${token})` }} />)}
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, color: 'var(--text-on-fill)', background: 'var(--ok)', borderRadius: rad(4), padding: sp('1px 7px') }}>Allow</span>
        </span>
      </div>
    </div>
  );
}
