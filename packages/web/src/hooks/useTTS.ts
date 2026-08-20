/**
 * Auto-speak: watches the event stream and queues new agent responses.
 *
 * Mounted once, from App.tsx. Two rules do most of the work here:
 *
 *  - **Nothing from before the hook mounted is ever spoken.** Opening the
 *    dashboard on a session that ran for an hour must not replay that hour.
 *    The cutoff is the mount time, not the event count.
 *  - **`'final'` debounces rather than waiting for `Stop`.** An agent emits
 *    several interstitial messages between tool calls and the last one is the
 *    answer, but only some harnesses give us a reliable end-of-turn signal.
 *    A quiet period after the most recent `agent_response` means the same thing
 *    and works across all five.
 */
import { useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { ttsPlayer, speechOptionsFrom } from '../lib/tts.js';
import { speechTextForEvent } from '../lib/tts-text.js';
import type { TimelineEvent } from '../lib/types.js';

/** How long a response must be the newest one before 'final' speaks it. */
const FINAL_DEBOUNCE_MS = 2000;

/** A short transport-bar label — the opening words of what is being said. */
function labelFor(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed;
}

export function useTTS(): void {
  useEffect(() => {
    const mountedAt = Date.now();
    const seen = new Set<string>();
    // One pending 'final' candidate per session: a new response supersedes it.
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    const speak = (event: TimelineEvent): void => {
      const { config } = useSessionStore.getState();
      if (!config) return;

      const text = speechTextForEvent(event, {
        codeBlocks: config.tts.codeBlocks,
        maxChars: config.tts.maxChars,
        speakLaymans: config.tts.speakLaymans,
      });
      if (!text) return;

      ttsPlayer.enqueue({
        id: event.id,
        text,
        label: labelFor(text),
        opts: speechOptionsFrom(config.tts),
      });
    };

    // The store notifies on every change, most of which are not new events, so
    // only the tail of the array is examined. A shorter array means the list was
    // replaced wholesale (a reconnect replay), which restarts the scan — `seen`
    // is what stops that from re-speaking anything.
    let scanned = 0;

    const check = (): void => {
      const state = useSessionStore.getState();
      const tts = state.config?.tts;
      const speaking = !!tts?.enabled && tts.autoSpeak !== 'none';

      // Which session are we listening to? An explicitly opened session wins
      // over the ambient active one; with neither, a single running session is
      // unambiguous enough to speak.
      const listening = state.viewingSessionId ?? state.activeSessionId;

      const events = state.events;
      if (events.length < scanned) scanned = 0;
      const from = scanned;
      scanned = events.length;

      for (let i = from; i < events.length; i++) {
        const event = events[i];
        if (event.type !== 'agent_response') continue;
        if (seen.has(event.id)) continue;
        seen.add(event.id);

        // Events are marked seen even while auto-speak is off, so switching it
        // on starts from that moment rather than flushing the whole backlog
        // accumulated since the page was opened.
        if (!speaking) continue;

        if (event.timestamp < mountedAt) continue;
        if (listening && event.sessionId !== listening) continue;

        if (tts.autoSpeak === 'all') {
          speak(event);
          continue;
        }

        // 'final': hold it, and let a newer response in the same session win.
        const existing = pending.get(event.sessionId);
        if (existing) clearTimeout(existing);
        pending.set(
          event.sessionId,
          setTimeout(() => {
            pending.delete(event.sessionId);
            speak(event);
          }, FINAL_DEBOUNCE_MS),
        );
      }
    };

    check();
    const unsubscribe = useSessionStore.subscribe(check);

    return () => {
      unsubscribe();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);
}
