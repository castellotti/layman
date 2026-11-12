import React, { useState, useRef } from 'react';

interface AskQuestionProps {
  eventId: string;
  onAsk: (question: string) => void;
  isLoading?: boolean;
}

export function AskQuestion({ eventId: _eventId, onAsk, isLoading = false }: AskQuestionProps) {
  const [question, setQuestion] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isLoading) return;
    onAsk(trimmed);
    setQuestion('');
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        ref={inputRef}
        type="text"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask a question about this action..."
        disabled={isLoading}
        className="flex-1 px-3 py-2 text-xs bg-bg border border-border-strong rounded-md text-text placeholder-text-faint focus:outline-none focus:border-accent disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!question.trim() || isLoading}
        className="px-3 py-2 text-xs font-medium bg-bg-pill border border-border-strong rounded-md text-text hover:bg-border-strong disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? '...' : 'Ask'}
      </button>
    </form>
  );
}
