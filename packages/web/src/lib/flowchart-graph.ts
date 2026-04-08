import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import type { TimelineEvent } from './types.js';
import { NODE_BORDER_COLORS, EVENT_ICONS } from './event-styles.js';
import { extractToolSpans, detectParallelGroups, getParallelEventIds } from './parallel-detection.js';

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
  if (type === 'drift_check' || type === 'drift_alert') {
    const suffix = event.data.driftType === 'rules' ? 'rules' : 'session';
    return `${type.replace(/_/g, ' ')} - ${suffix}`;
  }
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

function isFlowchartRelevant(event: TimelineEvent): boolean {
  const skip = new Set(['analysis_result', 'pre_compact', 'post_compact']);
  return !skip.has(event.type);
}

// Edge style constants
const EDGE_STYLES = {
  spine: { stroke: '#30363d', strokeWidth: 1 },
  fork: { stroke: '#58a6ff', strokeWidth: 1.5, strokeDasharray: '6 4' },
  branch: { stroke: '#30363d', strokeWidth: 1 },
  branchActive: { stroke: '#d29922', strokeWidth: 2 },
  branchCompleted: { stroke: '#3fb950', strokeWidth: 1.5 },
  branchFailed: { stroke: '#f85149', strokeWidth: 1.5, strokeDasharray: '8 4' },
  current: { stroke: '#58a6ff', strokeWidth: 1.5 },
} as const;

const MARKER_DEFAULTS = { type: 'arrowclosed' as const, width: 12, height: 12 };

function makeEdge(
  id: string,
  source: string,
  target: string,
  category: keyof typeof EDGE_STYLES,
  opts?: { animated?: boolean }
): Edge {
  const style = EDGE_STYLES[category];
  const isForkJoin = category === 'fork';
  return {
    id,
    source,
    target,
    type: isForkJoin ? 'smoothstep' : 'default',
    animated: opts?.animated ?? false,
    className: `edge-${category}`,
    style: { ...style },
    markerEnd: { ...MARKER_DEFAULTS, color: style.stroke },
  };
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

  // Detect parallel tool executions
  const spans = extractToolSpans(relevant);
  const groups = detectParallelGroups(relevant, spans);
  const parallelIds = getParallelEventIds(groups);

  const edges: Edge[] = [];
  let edgeCount = 0;

  // Build fork/join edges for each parallel group
  for (const group of groups) {
    const forkEvent = relevant[group.forkAfterIndex];
    const joinEvent = relevant[group.joinBeforeIndex];

    for (const span of group.spans) {
      // Collect all events in this branch in order
      const branchEvents: TimelineEvent[] = [span.pendingEvent];
      branchEvents.push(...span.intermediateEvents);
      if (span.completionEvent) branchEvents.push(span.completionEvent);
      branchEvents.sort((a, b) => a.timestamp - b.timestamp);

      // A branch is still active only if the pending event hasn't been resolved yet
      const isActive = span.pendingEvent.type === 'tool_call_pending' && !span.completionEvent;
      const isFailed = span.completionEvent?.type === 'tool_call_failed' || span.pendingEvent.type === 'tool_call_failed';

      // Fork edge: spine → branch start
      if (forkEvent && forkEvent.id !== branchEvents[0].id) {
        const e = makeEdge(`fork-${edgeCount++}`, forkEvent.id, branchEvents[0].id, 'fork', { animated: isActive });
        edges.push(e);
        g.setEdge(forkEvent.id, branchEvents[0].id);
      }

      // Sequential edges within the branch
      for (let i = 0; i < branchEvents.length - 1; i++) {
        const category = isActive ? 'branchActive' : isFailed ? 'branchFailed' : 'branchCompleted';
        const e = makeEdge(`branch-${edgeCount++}`, branchEvents[i].id, branchEvents[i + 1].id, category, { animated: isActive });
        edges.push(e);
        g.setEdge(branchEvents[i].id, branchEvents[i + 1].id);
      }

      // Join edge: branch end → spine
      const branchEnd = branchEvents[branchEvents.length - 1];
      if (joinEvent && branchEnd.id !== joinEvent.id) {
        const e = makeEdge(`join-${edgeCount++}`, branchEnd.id, joinEvent.id, 'fork', { animated: isActive });
        edges.push(e);
        g.setEdge(branchEnd.id, joinEvent.id);
      }
    }
  }

  // Build spine (sequential) edges for events NOT in parallel groups
  const lastEventId = relevant[relevant.length - 1]?.id;
  for (let i = 0; i < relevant.length - 1; i++) {
    const curr = relevant[i];
    const next = relevant[i + 1];

    // Skip if either event is inside a parallel group branch
    if (parallelIds.has(curr.id) || parallelIds.has(next.id)) continue;

    // Skip if this edge would duplicate a fork/join edge
    if (edges.some(e => e.source === curr.id && e.target === next.id)) continue;

    const isCurrent = next.id === lastEventId;
    const category = isCurrent ? 'current' : 'spine';
    const e = makeEdge(`seq-${edgeCount++}`, curr.id, next.id, category, { animated: isCurrent });
    edges.push(e);
    g.setEdge(curr.id, next.id);
  }

  // Apply dagre layout
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
