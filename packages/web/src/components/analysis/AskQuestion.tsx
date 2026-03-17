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
        className="flex-1 px-3 py-2 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!question.trim() || isLoading}
        className="px-3 py-2 text-xs font-medium bg-[#21262d] border border-[#30363d] rounded-md text-[#e6edf3] hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? '...' : 'Ask'}
      </button>
    </form>
  );
}
