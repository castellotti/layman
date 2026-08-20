/**
 * Compact speech transport, rendered inside the status bar.
 *
 * Invisible unless there is something to say about: speaking, queued, blocked by
 * autoplay policy, or reporting a failure. A permanent widget for a feature that
 * is off by default would just be clutter.
 */
import React, { useSyncExternalStore } from 'react';
import { ttsPlayer } from '../../lib/tts.js';

const buttonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'inherit',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
};

export function TTSBar() {
  const state = useSyncExternalStore(ttsPlayer.subscribe, ttsPlayer.getState);

  const speaking = state.status !== 'idle';
  const hasQueue = state.queueDepth > 0;
  // `muted` keeps the bar alive: muting stops playback and empties the queue, so
  // without this the control that unmutes would vanish along with it.
  if (!speaking && !hasQueue && !state.blocked && !state.error && !state.muted) return null;

  if (state.muted) {
    return (
      <button
        onClick={() => ttsPlayer.setMuted(false)}
        style={{ ...buttonStyle, color: 'var(--warn)', gap: 4 }}
        title="Speech is muted — click to unmute"
      >
        🔇 Muted
      </button>
    );
  }

  // Autoplay refusal is the expected state for a ?play=1 link opened in a fresh
  // tab. It is a prompt, not an error — one click and the queued turn speaks.
  if (state.blocked) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--warn)' }}>
        <button
          onClick={() => ttsPlayer.resume()}
          style={{ ...buttonStyle, color: 'var(--warn)', fontWeight: 500 }}
          title="Your browser blocked audio until you interact with the page"
        >
          ▸ Enable audio
        </button>
        <span style={{ color: 'var(--text-faint)' }}>
          ({state.queueDepth} queued)
        </span>
      </span>
    );
  }

  if (!speaking && !hasQueue && state.error) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--error)' }}>
        <span title={state.error} style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Speech failed: {state.error}
        </span>
        <button onClick={() => ttsPlayer.clearError()} style={{ ...buttonStyle, color: 'var(--text-faint)' }} title="Dismiss">
          ×
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
      <span style={{ color: 'var(--accent)' }}>
        {state.status === 'loading' ? '◌' : '▶'}
      </span>
      <span
        title={state.current?.label ?? ''}
        style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {state.current?.label ?? 'Speaking'}
      </span>
      {state.queueDepth > 1 && (
        <span style={{ color: 'var(--text-faint)' }}>+{state.queueDepth - 1}</span>
      )}
      <button onClick={() => ttsPlayer.skip()} style={buttonStyle} title="Skip to the next utterance">
        ⏭
      </button>
      <button onClick={() => ttsPlayer.stop()} style={buttonStyle} title="Stop and clear the queue">
        ⏹
      </button>
      <button
        onClick={() => ttsPlayer.setMuted(!state.muted)}
        style={{ ...buttonStyle, color: state.muted ? 'var(--warn)' : 'inherit' }}
        title={state.muted ? 'Unmute speech' : 'Mute speech'}
      >
        {state.muted ? '🔇' : '🔊'}
      </button>
    </span>
  );
}
