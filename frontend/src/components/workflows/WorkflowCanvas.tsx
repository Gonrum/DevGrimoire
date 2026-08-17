import { useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls,
  MiniMap, Connection, Edge, Node, useReactFlow, OnNodesChange, OnEdgesChange,
  IsValidConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { WorkflowCustomNode } from './WorkflowCustomNode';
import { WorkflowCustomEdge } from './WorkflowCustomEdge';

const nodeTypes = { workflowNode: WorkflowCustomNode };
const edgeTypes = { workflowEdge: WorkflowCustomEdge };

/** `Node.data` ist `Record<string, unknown>` — der Node-Typ daraus, geprüft statt behauptet. */
function nodeTypeOf(node: Node | undefined): string | undefined {
  const value = node?.data.type;
  return typeof value === 'string' ? value : undefined;
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (conn: Connection) => void;
  onSelectionChange: (sel: { nodes: Node[]; edges: Edge[] }) => void;
  onDrop: (event: React.DragEvent, position: { x: number; y: number }) => void;
}

function CanvasInner(p: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const isValidConnection = useCallback<IsValidConnection>((conn) => {
    if (conn.source === conn.target) return false;
    const target = p.nodes.find((n) => n.id === conn.target);
    const targetType = nodeTypeOf(target);
    if (targetType?.startsWith('trigger.')) return false;
    const duplicate = p.edges.some(
      (e) => e.source === conn.source && e.target === conn.target && e.sourceHandle === conn.sourceHandle,
    );
    return !duplicate;
  }, [p.nodes, p.edges]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    p.onDrop(event, position);
  }, [screenToFlowPosition, p]);

  // When the user releases the connection drag on a node's body (not directly
  // on a handle), find the node under the cursor and snap to its default input.
  // ReactFlow only auto-connects when the drop lands within connectionRadius
  // of a handle — this extends the snap zone to "anywhere on the target node".
  const onConnectEnd = useCallback((
    event: MouseEvent | TouchEvent,
    connectionState: { isValid?: boolean | null; fromHandle?: { nodeId?: string; id?: string | null; type?: 'source' | 'target' } | null; toHandle?: unknown },
  ) => {
    // If ReactFlow already accepted the connection via onConnect, nothing more to do.
    if (connectionState.isValid && connectionState.toHandle) return;

    const fromHandle = connectionState.fromHandle;
    if (!fromHandle || fromHandle.type !== 'source') return;
    const sourceId = fromHandle.nodeId;
    if (!sourceId) return;

    // Locate the node DOM element under the cursor
    const clientX = 'clientX' in event ? event.clientX : event.changedTouches?.[0]?.clientX;
    const clientY = 'clientY' in event ? event.clientY : event.changedTouches?.[0]?.clientY;
    if (clientX === undefined || clientY === undefined) return;

    const el = document.elementFromPoint(clientX, clientY);
    const nodeEl = el?.closest('.react-flow__node');
    if (!nodeEl) return;
    const targetId = nodeEl.getAttribute('data-id');
    if (!targetId || targetId === sourceId) return;

    // Only auto-connect to nodes that have an input handle (i.e. not triggers)
    const targetNode = p.nodes.find((n) => n.id === targetId);
    const targetType = nodeTypeOf(targetNode);
    if (targetType?.startsWith('trigger.')) return;

    p.onConnect({
      source: sourceId,
      target: targetId,
      sourceHandle: fromHandle.id ?? null,
      targetHandle: null,
    });
  }, [p]);

  const defaultEdgeOptions = useMemo(() => ({ type: 'workflowEdge' }), []);

  return (
    <div className="h-full w-full" ref={wrapperRef} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={p.nodes}
        edges={p.edges}
        onNodesChange={p.onNodesChange}
        onEdgesChange={p.onEdgesChange}
        onConnect={p.onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onSelectionChange={p.onSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionRadius={60}
        fitView
        proOptions={{ hideAttribution: true }}
        className="bg-gray-950"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1f2937" />
        <Controls className="!bg-gray-900 !border-gray-700" />
        <MiniMap pannable zoomable className="!bg-gray-900" nodeColor="#374151" maskColor="rgba(15,23,42,0.7)" />
      </ReactFlow>
    </div>
  );
}

export function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
