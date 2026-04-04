import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import type { TimelineEvent } from './types.js';
import { NODE_BORDER_COLORS, EVENT_ICONS } from './event-styles.js';

export type FlowchartNodeType = 'userPrompt' | 'toolCall' | 'agentResponse' | 'sessionEvent' | 'default';

export interface FlowchartNodeData {
  event: TimelineEvent;
  isSelected: boolean;
  icon: string;
  borderColor: string;
  label: string;
  sublabel: string;
  nodeType: FlowchartNodeType;
  [key: string]: unknown;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;

function classifyNode(type: string): FlowchartNodeType {
  if (type === 'user_prompt') return 'userPrompt';
  if (type.startsWith('tool_call_') || type === 'permission_request') return 'toolCall';
  if (type === 'agent_response') return 'agentResponse';
  if (type === 'session_start' || type === 'session_end') return 'sessionEvent';
  return 'default';
}

function getLabel(event: TimelineEvent): string {
  const type = event.type;
  if (type === 'user_prompt') return 'User Prompt';
  if (type === 'agent_response') return 'Agent Response';
  if (type === 'session_start') return 'Session Start';
  if (type === 'session_end') return 'Session End';
  if (type === 'permission_request') return 'Permission Request';
  if (type === 'subagent_start') return 'Subagent Start';
  if (type === 'subagent_stop') return 'Subagent Stop';
  if (type === 'notification') return 'Notification';
  if (event.data.toolName) return event.data.toolName;
  return type.replace(/_/g, ' ');
}

function getSublabel(event: TimelineEvent): string {
  const input = event.data.toolInput;
  if (!input) {
    if (event.data.prompt) return event.data.prompt.slice(0, 50);
    return '';
  }
  if (input.command) return String(input.command).slice(0, 40);
  if (input.file_path) return String(input.file_path).split('/').pop() ?? '';
  if (input.pattern) return String(input.pattern).slice(0, 40);
  if (input.query) return String(input.query).slice(0, 40);
  if (input.url) return String(input.url).slice(0, 40);
  if (input.prompt) return String(input.prompt).slice(0, 40);
  if (input.description) return String(input.description).slice(0, 40);
  return '';
}

/** Filter out events that are not useful in a flowchart (e.g. analysis_result which is metadata) */
function isFlowchartRelevant(event: TimelineEvent): boolean {
  const skip = new Set(['analysis_result', 'pre_compact', 'post_compact']);
  return !skip.has(event.type);
}

export function buildFlowchartGraph(
  events: TimelineEvent[],
  selectedEventId: string | null
): { nodes: Node<FlowchartNodeData>[]; edges: Edge[] } {
  const relevant = events.filter(isFlowchartRelevant);
  if (relevant.length === 0) return { nodes: [], edges: [] };

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });

  // Build nodes
  const nodes: Node<FlowchartNodeData>[] = [];
  for (const event of relevant) {
    g.setNode(event.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    nodes.push({
      id: event.id,
      type: 'flowchartNode',
      position: { x: 0, y: 0 },
      data: {
        event,
        isSelected: event.id === selectedEventId,
        icon: EVENT_ICONS[event.type] ?? '·',
        borderColor: NODE_BORDER_COLORS[event.type] ?? '#30363d',
        label: getLabel(event),
        sublabel: getSublabel(event),
        nodeType: classifyNode(event.type),
      },
    });
  }

  // Build edges
  const edges: Edge[] = [];

  // Sequential edges: connect each event to the next
  for (let i = 0; i < relevant.length - 1; i++) {
    edges.push({
      id: `seq-${i}`,
      source: relevant[i].id,
      target: relevant[i + 1].id,
      type: 'default',
      style: { stroke: '#30363d', strokeWidth: 1 },
      markerEnd: { type: 'arrowclosed' as const, color: '#30363d', width: 12, height: 12 },
    });
  }

  // Causal edges: tool_call_pending -> tool_call_completed/failed
  const pendingEvents = relevant.filter(
    e => e.type === 'tool_call_pending' || e.type === 'tool_call_approved'
  );
  for (const pending of pendingEvents) {
    const completion = relevant.find(
      e =>
        (e.type === 'tool_call_completed' || e.type === 'tool_call_failed') &&
        e.data.toolName === pending.data.toolName &&
        e.sessionId === pending.sessionId &&
        e.timestamp > pending.timestamp
    );
    if (completion && completion.id !== relevant[relevant.indexOf(pending) + 1]?.id) {
      g.setEdge(pending.id, completion.id);
      edges.push({
        id: `causal-${pending.id}-${completion.id}`,
        source: pending.id,
        target: completion.id,
        type: 'default',
        animated: true,
        style: {
          stroke: completion.type === 'tool_call_failed' ? '#f85149' : '#3fb950',
          strokeWidth: 1.5,
          strokeDasharray: '5 3',
        },
      });
    }
  }

  // Apply dagre layout
  for (const edge of edges) {
    if (g.node(edge.source) && g.node(edge.target)) {
      // Ensure edge exists in graph for layout
      if (!g.hasEdge(edge.source, edge.target)) {
        g.setEdge(edge.source, edge.target);
      }
    }
  }

  dagre.layout(g);

  // Apply positions
  for (const node of nodes) {
    const pos = g.node(node.id);
    if (pos) {
      node.position = {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      };
    }
  }

  return { nodes, edges };
}
