/**
 * Speak-this-aloud toggle. Sits beside CopyLinkButton on turn headers, on agent
 * response rows and on the highlight detail header.
 *
 * Clicking while this item is speaking stops it — the same button, because a
 * separate stop control next to every response would be noise, and stopping is
 * the only thing you ever want while something is talking.
 */
import React, { useSyncExternalStore } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { ttsPlayer, speechOptionsFrom } from '../../lib/tts.js';
import { toSpeakableText } from '../../lib/tts-text.js';

function SpeakerIcon({ size, muted }: { size: number; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 2.5a.5.5 0 0 0-.83-.37L4.3 4.75H2.5a.5.5 0 0 0-.5.5v5.5a.5.5 0 0 0 .5.5h1.8l2.87 2.62A.5.5 0 0 0 8 13.5v-11Z" />
      {muted ? (
        <path d="M10.72 6.22a.75.75 0 0 1 1.06 0L13 7.44l1.22-1.22a.75.75 0 1 1 1.06 1.06L14.06 8.5l1.22 1.22a.75.75 0 1 1-1.06 1.06L13 9.56l-1.22 1.22a.75.75 0 0 1-1.06-1.06l1.22-1.22-1.22-1.22a.75.75 0 0 1 0-1.06Z" />
      ) : (
        <path d="M10.9 4.6a.75.75 0 0 1 1.05-.15A4.5 4.5 0 0 1 13.75 8a4.5 4.5 0 0 1-1.8 3.55.75.75 0 1 1-.9-1.2A3 3 0 0 0 12.25 8a3 3 0 0 0-1.2-2.35.75.75 0 0 1-.15-1.05Z" />
      )}
    </svg>
  );
}

/** A ring that spins while synthesis is in flight. */
function LoadingRing({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <animateTransform
          attributeName="transform" type="rotate"
          from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

export function SpeakButton({
  id,
  text,
  size = 11,
  title = 'Speak this aloud',
}: {
  /** Event id — also the queue's dedupe key. */
  id: string;
  /** Raw markdown; sanitised here so callers never think about speech. */
  text: string;
  size?: number;
  title?: string;
}) {
  const config = useSessionStore((s) => s.config);
  const state = useSyncExternalStore(ttsPlayer.subscribe, ttsPlayer.getState);

  // Hidden entirely when TTS is off: an always-visible button that errors on
  // click would be worse than no button.
  if (!config?.tts.enabled) return null;

  const isCurrent = state.current?.id === id;
  const isQueued = !isCurrent && ttsPlayer.isActive(id);
  const isLoading = isCurrent && state.status === 'loading';
  const isPlaying = isCurrent && state.status === 'playing';
  const active = isCurrent || isQueued;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (active) {
      ttsPlayer.stop();
      return;
    }

    const speakable = toSpeakableText(text, {
      codeBlocks: config.tts.codeBlocks,
      maxChars: config.tts.maxChars,
    });
    if (!speakable) return;

    // An explicit click is a user gesture, so this is also the path that
    // recovers from an autoplay block.
    ttsPlayer.replaceWith({
      id,
      text: speakable,
      label: speakable.length > 60 ? `${speakable.slice(0, 59)}…` : speakable,
      opts: speechOptionsFrom(config.tts),
    });
  };

  const color = isPlaying ? 'var(--accent)' : active ? 'var(--text-muted)' : 'var(--text-faint)';

  return (
    <button
      onClick={handleClick}
      title={active ? 'Stop speaking' : title}
      aria-label={active ? 'Stop speaking' : title}
      data-print-hide
      data-speak-button
      style={{
        display: 'inline-flex', alignItems: 'center',
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        color, transition: 'color 0.1s', flexShrink: 0, lineHeight: 1,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = 'var(--text)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = 'var(--text-faint)'; }}
    >
      {isLoading ? <LoadingRing size={size} /> : <SpeakerIcon size={size} muted={active && !isPlaying} />}
    </button>
  );
}
