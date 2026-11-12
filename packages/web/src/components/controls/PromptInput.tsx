import React, { useState, useRef, useCallback } from 'react';

interface PromptInputProps {
  sessionId: string;
  disabled?: boolean;
}

export function PromptInput({ sessionId, disabled }: PromptInputProps) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(async () => {
    const prompt = text.trim();
    if (!prompt || status === 'sending') return;

    setStatus('sending');
    setErrorMsg('');

    try {
      const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({})) as { method?: string };
        setText('');
        setStatus('sent');
        // Queued prompts take a moment longer to appear — keep the sent indicator up longer
        setTimeout(() => setStatus('idle'), data.method === 'queued' ? 4000 : 2000);
        // Reset textarea height
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      } else {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        setErrorMsg(data.error ?? `HTTP ${res.status}`);
        setStatus('error');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send');
      setStatus('error');
    }
  }, [text, sessionId, status]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    if (status === 'error') setStatus('idle');
  };

  const isSending = status === 'sending';
  const isSent = status === 'sent';

  return (
    <div className="border-t border-border-strong bg-bg px-3 py-2 shrink-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={disabled || isSending}
            placeholder="Send a prompt to OpenCode… (Enter to send, Shift+Enter for newline)"
            rows={1}
            className={[
              'w-full resize-none rounded-md px-3 py-2 text-sm bg-bg-card text-text',
              'border placeholder-text-faint outline-none transition-colors',
              'focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed',
              status === 'error' ? 'border-error' : 'border-border-strong',
            ].join(' ')}
            style={{ minHeight: '36px', maxHeight: '160px' }}
          />
        </div>
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || isSending || disabled}
          className={[
            'shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors mt-0',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            isSent
              ? 'bg-ok text-text-on-fill'
              : 'bg-info hover:bg-info/85 text-text-on-fill',
          ].join(' ')}
        >
          {isSending ? '…' : isSent ? '✓' : '↑'}
        </button>
      </div>
      {status === 'error' && errorMsg && (
        <p className="mt-1 text-[11px] text-error">{errorMsg}</p>
      )}
    </div>
  );
}
