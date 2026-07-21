import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  useViewport,
  ReactFlowProvider,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './flowchart.css';
import { useEventStore } from '../../hooks/useEventStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { TimelineEvent } from '../../lib/types.js';
import { buildFlowchartGraph, type FlowchartNodeData } from '../../lib/flowchart-graph.js';
import { FlowchartNode } from './FlowchartNodes.js';

const nodeTypes: NodeTypes = { flowchartNode: FlowchartNode };
const FOLLOW_MIN_ZOOM = 0.75;

interface FlowchartInnerProps {
  /** When provided, uses these events instead of the live event store */
  externalEvents?: TimelineEvent[];
  /** Callback when a node is clicked (for historical sessions) */
  onSelectEvent?: (id: string | null) => void;
  /** Override selected event id (for historical sessions) */
  externalSelectedEventId?: string | null;
}

function FlowchartInner({ externalEvents, onSelectEvent, externalSelectedEventId }: FlowchartInnerProps) {
  const { fitView, setCenter, getNode } = useReactFlow();
  const { zoom } = useViewport();
  const { setSelectedEvent, selectedEventId: storeSelectedEventId } = useSessionStore();

  const { events: liveEvents } = useEventStore({
    promptsOnly: false,
    requestsOnly: false,
  });

  const events = externalEvents ?? liveEvents;
  const selectedEventId = externalSelectedEventId !== undefined ? externalSelectedEventId : storeSelectedEventId;

  const { nodes, edges } = useMemo(
    () => buildFlowchartGraph(events, selectedEventId),
    [events, selectedEventId]
  );

  // Follow-latest: default on. Keeps the newest node centered instead of fitting the whole graph.
  const [followLatest, setFollowLatest] = useState(true);

  // Track previous event count so we only react to actual new events
  const prevCountRef = useRef(events.length);

  useEffect(() => {
    if (nodes.length === 0 || events.length === prevCountRef.current) return;
    prevCountRef.current = events.length;
    if (!followLatest) return;
    const newest = nodes[nodes.length - 1];
    const t = setTimeout(() => {
      setCenter(newest.position.x + 110, newest.position.y + 32, {
        zoom: Math.max(zoom, FOLLOW_MIN_ZOOM),
        duration: 250,
      });
    }, 80);
    return () => clearTimeout(t);
  }, [nodes, events.length, followLatest, zoom, setCenter]);

  // Manual pan/zoom disables follow-latest. `event` is null for our own programmatic
  // setCenter/fitView calls and non-null for real pointer/touch gestures.
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) setFollowLatest(false);
  }, []);

  const handleFitAll = useCallback(() => {
    setFollowLatest(false);
    fitView({ padding: 0.3, maxZoom: 1.2, duration: 200 });
  }, [fitView]);

  // Pan to selected node when selectedEventId changes
  useEffect(() => {
    if (!selectedEventId) return;
    const t = setTimeout(() => {
      const node = getNode(selectedEventId);
      if (node) {
        setCenter(node.position.x + 110, node.position.y + 32, { zoom: 1, duration: 300 });
      }
    }, 100);
    return () => clearTimeout(t);
  }, [selectedEventId, getNode, setCenter]);

  const handleSelectEvent = onSelectEvent ?? setSelectedEvent;

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node<FlowchartNodeData>) => {
      handleSelectEvent(node.id);
    },
    [handleSelectEvent]
  );

  const onPaneClick = useCallback(() => {
    handleSelectEvent(null);
  }, [handleSelectEvent]);

  // Keyboard controls: arrow keys for pan, +/- for zoom
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

      const PAN_STEP = 50;
      switch (e.key) {
        case '+':
        case '=':
          setFollowLatest(false);
          fitView({ padding: 0.1, maxZoom: 2, duration: 150 });
          break;
        case '-':
          setFollowLatest(false);
          fitView({ padding: 0.5, maxZoom: 0.5, duration: 150 });
          break;
        case 'ArrowLeft':
          // Pan is handled by React Flow internally but we can use viewport manipulation
          break;
        case 'ArrowRight':
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [fitView]);

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#484f58] text-xs">
        Waiting for events...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <FlowchartToolbar
        nodeCount={nodes.length}
        zoom={zoom}
        followLatest={followLatest}
        onToggleFollow={() => setFollowLatest((v) => !v)}
        onFitAll={handleFitAll}
      />
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onMoveStart={onMoveStart}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          minZoom={0.1}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: 'default' }}
        >
          <Background gap={24} size={1} color="#161b22" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => (node.data as FlowchartNodeData).borderColor ?? '#30363d'}
            nodeStrokeWidth={0}
            maskColor="rgba(11,14,20,0.75)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}

function FlowchartToolbar({
  nodeCount,
  zoom,
  followLatest,
  onToggleFollow,
  onFitAll,
}: {
  nodeCount: number;
  zoom: number;
  followLatest: boolean;
  onToggleFollow: () => void;
  onFitAll: () => void;
}) {
  return (
    <div
      data-print-hide
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', background: 'var(--bg-raised)',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}
    >
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
        {nodeCount} node{nodeCount === 1 ? '' : 's'}
      </span>
      <div style={{ flex: 1 }} />
      <button
        onClick={onToggleFollow}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', fontSize: 11, fontFamily: 'var(--font-ui)', fontWeight: 500,
          borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap',
          background: followLatest ? 'rgba(76,195,138,0.12)' : 'transparent',
          color: followLatest ? 'var(--ok)' : 'var(--text-muted)',
          border: followLatest ? '1px solid rgba(76,195,138,0.3)' : '1px solid var(--border-strong)',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: followLatest ? 'var(--ok)' : 'var(--text-muted)' }} />
        Follow latest
      </button>
      <button
        onClick={onFitAll}
        style={{
          padding: '4px 10px', fontSize: 11, fontFamily: 'var(--font-ui)',
          color: 'var(--text-muted)', background: 'transparent',
          border: '1px solid var(--border-strong)', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        Fit all
      </button>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
        zoom {zoom.toFixed(1)}×
      </span>
    </div>
  );
}

interface FlowchartViewProps {
  /** When provided, uses these events instead of the live event store */
  events?: TimelineEvent[];
  /** Callback when a node is clicked (for historical sessions) */
  onSelectEvent?: (id: string | null) => void;
  /** Override selected event id (for historical sessions) */
  selectedEventId?: string | null;
}

export function FlowchartView({ events, onSelectEvent, selectedEventId }: FlowchartViewProps = {}) {
  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <FlowchartInner
          externalEvents={events}
          onSelectEvent={onSelectEvent}
          externalSelectedEventId={selectedEventId}
        />
      </ReactFlowProvider>
    </div>
  );
}
