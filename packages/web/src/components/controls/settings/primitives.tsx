import React, { useState } from 'react';
import { SegmentedControl } from '../../primitives/index.js';

export const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '11px 0',
  borderBottom: '1px solid var(--border-subtle)',
};

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', paddingBottom: 4 }}>
      {children}
    </div>
  );
}

export function SectionIntro({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, margin: '0 0 4px' }}>
      {children}
    </p>
  );
}

export function ToggleRow({
  label, desc, checked, onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
          {desc && <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>{desc}</span>}
        </span>
        <button
          onClick={onChange}
          style={{
            width: 34,
            height: 18,
            borderRadius: 9,
            border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
            background: checked ? 'var(--bg-selected)' : 'var(--bg-card)',
            position: 'relative',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: checked ? 18 : 2,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: checked ? 'var(--accent)' : 'var(--text-faint)',
              transition: 'left 0.15s',
            }}
          />
        </button>
      </div>
    </div>
  );
}

const LABEL_WIDTH = 110;

export function SegmentRow<T extends string>({
  label, desc, options, value, onChange, labelWidth = LABEL_WIDTH,
}: {
  label: string;
  desc?: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  labelWidth?: number;
}) {
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text)', width: labelWidth, flexShrink: 0 }}>{label}</span>
        <SegmentedControl options={options} value={value} onChange={onChange} />
      </div>
      {desc && (
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, paddingLeft: labelWidth + 12 }}>
          {desc}
        </span>
      )}
    </div>
  );
}

export function FieldRow({
  label, value, onChange, type = 'text', placeholder, readOnly, action, labelWidth = LABEL_WIDTH, selectOptions,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  type?: 'text' | 'password' | 'number';
  placeholder?: string;
  readOnly?: boolean;
  action?: React.ReactNode;
  labelWidth?: number;
  /** When provided, renders a <select> of these options instead of a text input. */
  selectOptions?: string[];
}) {
  const isReadOnly = readOnly ?? !onChange;
  const fieldStyle: React.CSSProperties = {
    flex: 1,
    maxWidth: 300,
    padding: '5px 10px',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    color: isReadOnly ? 'var(--text-body)' : 'var(--text)',
    outline: 'none',
    boxSizing: 'border-box',
  };
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text)', width: labelWidth, flexShrink: 0 }}>{label}</span>
        {selectOptions ? (
          <select
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            style={fieldStyle}
          >
            {!selectOptions.includes(value) && value && <option value={value}>{value}</option>}
            {selectOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type={type}
            value={value}
            readOnly={isReadOnly}
            onChange={onChange ? (e) => onChange(e.target.value) : undefined}
            placeholder={placeholder}
            style={fieldStyle}
          />
        )}
        {action}
      </div>
    </div>
  );
}

export function InfoRow({
  label, value, dotColor, action,
}: {
  label: string;
  value: string;
  dotColor?: string;
  action?: React.ReactNode;
}) {
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
        <div style={{ flex: 1 }} />
        {action}
        {dotColor && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{value}</span>
      </div>
    </div>
  );
}

export interface ThresholdStop {
  name: string;
  color: string;
  value: number;
  onChange: (v: number) => void;
}

export function ThresholdRow({ label, stops }: { label: string; stops: ThresholdStop[] }) {
  return (
    <div style={ROW_STYLE}>
      <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {stops.map((s) => (
          <span
            key={s.name}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 9px',
              borderRadius: 5,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
            <span style={{ color: s.color }}>{s.name}</span>
            <input
              type="number"
              min={0}
              max={100}
              value={s.value}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (v >= 0 && v <= 100) s.onChange(v);
              }}
              style={{
                width: 34,
                background: 'transparent',
                border: 'none',
                color: 'var(--text)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
                outline: 'none',
              }}
            />
            %
          </span>
        ))}
      </div>
    </div>
  );
}

export function ActionRow({
  label, hint, onClick, disabled, variant = 'default',
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'danger';
}) {
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={onClick}
          disabled={disabled}
          style={{
            padding: '5px 12px',
            fontSize: 11,
            fontFamily: 'var(--font-ui)',
            color: variant === 'danger' ? 'var(--error)' : 'var(--text-body)',
            background: 'transparent',
            border: `1px solid ${variant === 'danger' ? 'var(--error)' : 'var(--border-strong)'}`,
            borderRadius: 5,
            cursor: disabled ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {label}
        </button>
        {hint && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{hint}</span>}
      </div>
    </div>
  );
}

export function CustomRow({ children }: { children: React.ReactNode }) {
  return <div style={ROW_STYLE}>{children}</div>;
}

const trimmed = (draft: string) => draft.trim() || null;

/** Inline code in a setting's help text. */
export function Code({ children }: { children: React.ReactNode }) {
  return <code style={{ fontFamily: 'var(--font-mono)' }}>{children}</code>;
}

/**
 * A setting that is a list of short strings: a field to add one, a chip per entry to remove it, and
 * a line of help. `normalise` turns the draft into an entry (null refuses it; default: trimmed,
 * blank refused); `withEntry` adds it (default: appended once).
 */
export function StringListRow({
  label, placeholder, list, onChange, normalise = trimmed, withEntry, help,
}: {
  label: string;
  placeholder: string;
  list: string[];
  onChange: (next: string[]) => void;
  normalise?: (draft: string) => string | null;
  withEntry?: (list: string[], entry: string) => string[];
  help: React.ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const entry = normalise(draft);
  const add = () => {
    if (!entry) return;
    onChange(withEntry ? withEntry(list, entry) : list.includes(entry) ? list : [...list, entry]);
    setDraft('');
  };
  return (
    <CustomRow>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{label}</span>
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          aria-label={`Add to ${label}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          spellCheck={false}
          style={{ width: 200, padding: '4px 6px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 5, color: 'var(--text)', outline: 'none' }}
        />
        <button type="button" onClick={add} disabled={!entry}
          style={{ padding: '4px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border-strong)', background: 'var(--bg-card)', color: entry ? 'var(--text)' : 'var(--text-faint)', cursor: entry ? 'pointer' : 'default' }}>
          Add
        </button>
      </div>
      {list.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {list.map((d) => (
            <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 4px 1px 8px', fontSize: 11, fontFamily: 'var(--font-mono)', borderRadius: 10, border: '1px solid var(--border-strong)', color: 'var(--text-body)' }}>
              {d}
              <button type="button" aria-label={`Remove ${d}`} onClick={() => onChange(list.filter((x) => x !== d))}
                style={{ background: 'none', border: 'none', padding: '0 3px', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 12, lineHeight: 1 }}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>{help}</span>
    </CustomRow>
  );
}
