import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { FlowchartNodeData } from '../../lib/flowchart-graph.js';
import { tokenColor } from '../../lib/tokens.js';
import { EventIcon } from '../primitives/EventIcon.js';
import { Ripple } from '../primitives/motion.js';

function FlowchartNodeComponent({ data }: { data: FlowchartNodeData }) {
  const { event, isSelected, borderToken, borderColor, label, sublabel, nodeType } = data;
  const isPending = event.type === 'tool_call_pending';
  const isFailed = event.type === 'tool_call_failed';
  const riskLevel = event.riskLevel;

  return (
    <>
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <div
        className={`rounded-lg cursor-pointer transition-all duration-150 hover:brightness-125 ${
          isSelected ? 'ring-2 ring-accent/60' : ''
        }`}
        style={{
          width: 220,
          minHeight: 56,
          border: `1.5px solid ${borderColor}`,
          background: isSelected ? 'var(--bg-selected)' : 'var(--bg-code)',
          boxShadow: isPending
            ? `0 0 12px ${tokenColor(borderToken, '19%')}`
            : isSelected
            ? `0 0 8px ${tokenColor('accent', '15%')}`
            : '0 1px 3px rgba(0,0,0,0.3)',
        }}
      >
        {/* Top row: icon + label + risk */}
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5">
          <span className="relative shrink-0 inline-flex" style={{ color: borderColor }}>
            <EventIcon type={event.type} />
            {isPending && <Ripple color={borderColor} size={13} />}
          </span>
          <span
            className={`text-[11px] font-mono font-semibold truncate ${
              nodeType === 'userPrompt' ? 'text-info'
              : nodeType === 'agentResponse' ? 'text-ok'
              : isFailed ? 'text-error'
              : 'text-text'
            }`}
          >
            {label}
          </span>
          <span className="flex-1" />
          {riskLevel && riskLevel !== 'low' && (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{
                color: tokenColor(riskLevel === 'high' ? 'error' : 'warn'),
                background: tokenColor(riskLevel === 'high' ? 'error' : 'warn', '8%'),
              }}
            >
              {riskLevel}
            </span>
          )}
        </div>
        {/* Bottom row: sublabel */}
        {sublabel && (
          <div className="px-3 pb-2 pt-0">
            <span className="text-[10px] text-text-muted font-mono truncate block">
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
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
    </>
  );
}

export const FlowchartNode = memo(FlowchartNodeComponent);
