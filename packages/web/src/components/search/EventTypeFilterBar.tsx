import React from 'react';
import type { EventTypeFilters } from '../../stores/searchStore.js';

interface FilterPill {
  key: keyof EventTypeFilters;
  label: string;
  subToggle?: keyof EventTypeFilters;
  subLabel?: string;
  activeClass?: string;
}

const PILLS: FilterPill[] = [
  { key: 'prompts', label: 'Prompts' },
  { key: 'responses', label: 'Responses', subToggle: 'responseFinalOnly', subLabel: 'Final only' },
  { key: 'requests', label: 'Requests' },
  { key: 'questions', label: 'Questions' },
  { key: 'tools', label: 'Tools' },
  { key: 'laymans', label: "Layman's" },
  { key: 'analysis', label: 'Analysis' },
  { key: 'risk', label: 'Risk', activeClass: 'bg-[#21262d] border-[#d29922] text-[#d29922]' },
  { key: 'system', label: 'System' },
];

interface EventTypeFilterBarProps {
  filters: EventTypeFilters;
  onChange: (partial: Partial<EventTypeFilters>) => void;
}

export function EventTypeFilterBar({ filters, onChange }: EventTypeFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
      {PILLS.map((pill) => {
        const active = filters[pill.key];
        return (
          <div key={pill.key} className="flex items-center gap-0.5">
            <button
              onClick={() => onChange({ [pill.key]: !active })}
              className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                active
                  ? (pill.activeClass ?? 'bg-[#21262d] border-[#58a6ff] text-[#e6edf3]')
                  : 'bg-transparent border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
              }`}
            >
              {pill.label}
            </button>
            {pill.subToggle && active && (
              <button
                onClick={() => onChange({ [pill.subToggle!]: !filters[pill.subToggle!] })}
                className={`px-1.5 py-0.5 text-[9px] rounded-full border transition-colors ${
                  filters[pill.subToggle!]
                    ? 'bg-[#21262d] border-[#d29922] text-[#d29922]'
                    : 'bg-transparent border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                }`}
                title={pill.subLabel}
              >
                {pill.subLabel}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
