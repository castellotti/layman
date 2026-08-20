/**
 * Text-to-speech settings.
 *
 * Model and voice lists are fetched, never hardcoded: which voices exist depends
 * entirely on which models the user has downloaded into speaches, and a stale
 * hardcoded list would offer voices that 422 on use.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, SectionIntro, FieldRow, SegmentRow, ToggleRow, CustomRow, ROW_STYLE } from './primitives.js';
import { ttsPlayer, speechOptionsFrom } from '../../../lib/tts.js';

const SAMPLE_TEXT =
  'Layman is connected. This is how the agent’s responses will sound while you work.';

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

function SliderRow({
  label, desc, value, min, max, step, format, onChange,
}: {
  label: string;
  desc?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text)', width: 110, flexShrink: 0 }}>{label}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1, maxWidth: 240, accentColor: 'var(--accent)' }}
        />
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)',
          width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
        }}>
          {format(value)}
        </span>
      </div>
      {desc && (
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, paddingLeft: 122 }}>
          {desc}
        </span>
      )}
    </div>
  );
}

export function TTSSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const tts = config.tts;

  const [models, setModels] = useState<string[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const update = (updates: Partial<LaymanConfig['tts']>) => {
    onSend({ type: 'config:update', config: { tts: { ...tts, ...updates } } });
  };

  const fetchLists = useCallback(async () => {
    setFetching(true);
    setListError(null);
    try {
      const [modelsRes, voicesRes] = await Promise.all([
        fetch('/api/tts/models'),
        fetch('/api/tts/voices'),
      ]);
      const modelsData = await modelsRes.json() as { models?: string[]; error?: string };
      const voicesData = await voicesRes.json() as { voices?: string[]; error?: string };

      if (modelsData.error || voicesData.error) {
        setListError(modelsData.error ?? voicesData.error ?? 'Could not reach speaches');
      }
      setModels(modelsData.models ?? []);
      setVoices(voicesData.voices ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setModels([]);
      setVoices([]);
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    if (tts.enabled) void fetchLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tts.enabled, tts.endpoint]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/tts/test', { method: 'POST' });
      setTestResult(await res.json() as TestResult);
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const speakSample = () => {
    // A click is a user gesture, so this doubles as the autoplay unlock.
    ttsPlayer.replaceWith({
      id: `tts-sample-${Date.now()}`,
      text: SAMPLE_TEXT,
      label: 'Voice sample',
      opts: speechOptionsFrom(tts),
    });
  };

  return (
    <>
      <SectionTitle>Text to speech</SectionTitle>
      <SectionIntro>
        Reads agent responses aloud through a <a href="https://github.com/speaches-ai/speaches" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>speaches</a> server.
        Requests go through Layman rather than straight from the browser, because speaches
        disables CORS unless it was started with <code>allow_origins</code>.
      </SectionIntro>

      <ToggleRow
        label="Enable speech"
        desc="Adds speaker buttons to agent responses and turn headers."
        checked={tts.enabled}
        onChange={() => update({ enabled: !tts.enabled })}
      />

      <FieldRow
        label="Endpoint"
        value={tts.endpoint}
        placeholder="http://localhost:8000"
        onChange={(v) => update({ endpoint: v })}
        action={
          <button
            onClick={() => void runTest()}
            disabled={testing}
            style={{
              fontSize: 10.5, color: 'var(--accent)', background: 'none', border: 'none',
              cursor: testing ? 'default' : 'pointer', opacity: testing ? 0.4 : 1,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        }
      />
      {testResult && (
        <p style={{
          fontSize: 10.5, margin: '0 0 6px',
          color: testResult.ok ? 'var(--ok)' : 'var(--error)',
        }}>
          {testResult.ok
            ? `Connected — synthesised in ${testResult.latencyMs} ms`
            : `Failed: ${testResult.error ?? 'unknown error'}`}
        </p>
      )}

      <FieldRow
        label="API key"
        type="password"
        value={tts.apiKey}
        placeholder="Only if speaches was started with an api_key"
        onChange={(v) => update({ apiKey: v })}
      />

      <FieldRow
        label="Model"
        value={tts.model}
        placeholder="speaches-ai/Kokoro-82M-v1.0-ONNX"
        selectOptions={models.length ? models : undefined}
        onChange={(v) => update({ model: v })}
        action={
          <button
            onClick={() => void fetchLists()}
            disabled={fetching}
            style={{
              fontSize: 10.5, color: 'var(--accent)', background: 'none', border: 'none',
              cursor: fetching ? 'default' : 'pointer', opacity: fetching ? 0.4 : 1,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {fetching ? 'Fetching…' : '⟳ Fetch'}
          </button>
        }
      />

      <FieldRow
        label="Voice"
        value={tts.voice}
        placeholder="af_heart"
        selectOptions={voices.length ? voices : undefined}
        onChange={(v) => update({ voice: v })}
      />
      {listError && (
        <p style={{ fontSize: 10.5, color: 'var(--error)', margin: '0 0 6px' }}>{listError}</p>
      )}
      {!listError && tts.enabled && !fetching && models.length === 0 && (
        <p style={{ fontSize: 10.5, color: 'var(--warn)', margin: '0 0 6px' }}>
          speaches has no models installed. Download one with{' '}
          <code>curl -X POST {tts.endpoint || 'http://localhost:8000'}/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX</code>
        </p>
      )}

      {/*
        Capped at speaches' own accepted range rather than the schema's wider
        one: it rejects anything outside 0.5–2.0 with a 422, and a slider that
        can reach a value the server refuses is a bug the user has to diagnose.
        The schema stays permissive because other backends differ.
      */}
      <SliderRow
        label="Speed"
        desc="Sent to speaches. Changes tempo while keeping the voice's pitch. speaches accepts 0.5× to 2×."
        value={tts.speed}
        min={0.5}
        max={2}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(v) => update({ speed: v })}
      />

      <SliderRow
        label="Playback rate"
        desc="Applied in the browser, after synthesis."
        value={tts.playbackRate}
        min={0.5}
        max={3}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(v) => update({ playbackRate: v })}
      />

      <ToggleRow
        label="Preserve pitch"
        desc="On, playback rate changes tempo only. Off, it pitch-shifts too — the classic sped-up-tape sound. speaches has no pitch control of its own, so this is the only way to alter pitch."
        checked={tts.preservePitch}
        onChange={() => update({ preservePitch: !tts.preservePitch })}
      />

      <SegmentRow
        label="Auto-speak"
        desc="Final waits for a two-second pause, so only the answer is read rather than every message between tool calls."
        options={[
          { label: 'Off', value: 'none' },
          { label: 'Final only', value: 'final' },
          { label: 'Every message', value: 'all' },
        ]}
        value={tts.autoSpeak}
        onChange={(v) => update({ autoSpeak: v })}
      />

      <SegmentRow
        label="Code blocks"
        desc="Reading forty lines of source aloud helps nobody."
        options={[
          { label: 'Say "code block"', value: 'announce' },
          { label: 'Skip silently', value: 'skip' },
        ]}
        value={tts.codeBlocks}
        onChange={(v) => update({ codeBlocks: v })}
      />

      <ToggleRow
        label="Speak the plain-English explanation"
        desc="Reads the layman's explanation instead of the agent's own words. Requires auto-explain; falls back to the response where no explanation exists."
        checked={tts.speakLaymans}
        onChange={() => update({ speakLaymans: !tts.speakLaymans })}
      />

      <ToggleRow
        label="Call speaches directly"
        desc="Skips the Layman proxy. Only works if speaches was started with allow_origins covering this page, and sends the API key from the browser."
        checked={tts.direct}
        onChange={() => update({ direct: !tts.direct })}
      />

      <FieldRow
        label="Max characters"
        type="number"
        value={String(tts.maxChars)}
        onChange={(v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 200 && n <= 20000) update({ maxChars: n });
        }}
      />

      <CustomRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={speakSample}
            style={{
              padding: '5px 12px', fontSize: 11, fontFamily: 'var(--font-ui)',
              color: 'var(--text-body)', background: 'transparent',
              border: '1px solid var(--border-strong)', borderRadius: 5, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            🔊 Speak sample
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            Hear the current voice, speed and pitch settings.
          </span>
        </div>
      </CustomRow>
    </>
  );
}
