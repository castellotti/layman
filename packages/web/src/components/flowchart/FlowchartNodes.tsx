import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { FlowchartNodeData } from '../../lib/flowchart-graph.js';

function FlowchartNodeComponent({ data }: { data: FlowchartNodeData }) {
  const { event, isSelected, icon, borderColor, label, sublabel, nodeType } = data;
  const isPending = event.type === 'tool_call_pending';
  const isFailed = event.type === 'tool_call_failed';
  const riskLevel = event.riskLevel;

  return (
    <>
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div
        className={`rounded-lg cursor-pointer transition-all duration-150 hover:brightness-125 ${
          isSelected ? 'ring-2 ring-[#58a6ff]/60' : ''
        }`}
        style={{
          width: 220,
          minHeight: 56,
          border: `1.5px solid ${borderColor}`,
          background: isSelected ? '#1c2333' : '#0d1117',
          boxShadow: isPending
            ? `0 0 12px ${borderColor}30`
            : isSelected
            ? '0 0 8px rgba(88,166,255,0.15)'
            : '0 1px 3px rgba(0,0,0,0.3)',
        }}
      >
        {/* Top row: icon + label + risk */}
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5">
          <span className="text-[12px] shrink-0">{icon}</span>
          <span
            className={`text-[11px] font-mono font-semibold truncate ${
              nodeType === 'userPrompt' ? 'text-[#58a6ff]'
              : nodeType === 'agentResponse' ? 'text-[#3fb950]'
              : isFailed ? 'text-[#f85149]'
              : 'text-[#e6edf3]'
            }`}
          >
            {label}
          </span>
          <span className="flex-1" />
          {riskLevel && riskLevel !== 'low' && (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{
                color: riskLevel === 'high' ? '#f85149' : '#d29922',
                background: riskLevel === 'high' ? '#f8514915' : '#d2992215',
              }}
            >
              {riskLevel}
            </span>
          )}
        </div>
        {/* Bottom row: sublabel */}
        {sublabel && (
          <div className="px-3 pb-2 pt-0">
            <span className="text-[10px] text-[#8b949e] font-mono truncate block">
              {sublabel}
            </span>
          </div>
        )}
        {/* Animated border for pending */}
        {isPending && (
          <div
            className="absolute inset-0 rounded-lg pointer-events-none animate-pulse"
            style={{ border: `1.5px solid ${borderColor}` }}
          />
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-0 !w-0 !h-0" />
    </>
  );
}

export const FlowchartNode = memo(FlowchartNodeComponent);
