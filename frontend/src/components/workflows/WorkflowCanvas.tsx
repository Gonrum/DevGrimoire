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
    const targetType = (target?.data as { type?: string })?.type;
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

  const defaultEdgeOptions = useMemo(() => ({ type: 'workflowEdge' }), []);

  return (
    <div className="h-full w-full" ref={wrapperRef} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={p.nodes}
        edges={p.edges}
        onNodesChange={p.onNodesChange}
        onEdgesChange={p.onEdgesChange}
        onConnect={p.onConnect}
        isValidConnection={isValidConnection}
        onSelectionChange={p.onSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
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
