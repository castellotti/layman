import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useReactFlow,
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
  const { setSelectedEvent, selectedEventId: storeSelectedEventId } = useSessionStore();

  const { events: liveEvents } = useEventStore({
    promptsOnly: false,
    responsesOnly: false,
    requestsOnly: false,
    riskyOnly: false,
  });

  const events = externalEvents ?? liveEvents;
  const selectedEventId = externalSelectedEventId !== undefined ? externalSelectedEventId : storeSelectedEventId;

  const { nodes, edges } = useMemo(
    () => buildFlowchartGraph(events, selectedEventId),
    [events, selectedEventId]
  );

  // Track previous event count for auto-fit
  const prevCountRef = useRef(events.length);

  // Auto-fit when events change significantly
  useEffect(() => {
    if (nodes.length > 0 && events.length !== prevCountRef.current) {
      prevCountRef.current = events.length;
      const t = setTimeout(() => fitView({ padding: 0.3, maxZoom: 1.2, duration: 200 }), 80);
      return () => clearTimeout(t);
    }
  }, [nodes.length, events.length, fitView]);

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
          fitView({ padding: 0.1, maxZoom: 2, duration: 150 });
          break;
        case '-':
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
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
      minZoom={0.1}
      maxZoom={2.5}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: 'default' }}
    >
      <Background gap={24} size={1} color="#161b22" />
      <Controls showInteractive={false} />
    </ReactFlow>
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
