import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';

export interface WorkflowEdgeData {
  branch?: 'success' | 'failure' | 'custom' | 'always';
  condition?: Record<string, unknown>;
  onDelete?: (id: string) => void;
  [key: string]: unknown;
}

export function WorkflowCustomEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const data = (props.data ?? {}) as WorkflowEdgeData;
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const branch = data.branch ?? 'always';
  const stroke = selected ? '#22d3ee' : branch === 'failure' ? '#f87171' : branch === 'custom' ? '#c084fc' : '#64748b';

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke, strokeWidth: selected ? 2.5 : 1.5 }} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="nodrag nopan flex items-center gap-1"
        >
          {branch !== 'always' && (
            <span className={pillClass(branch)}>{branch}</span>
          )}
          {(hovered || selected) && (
            <button
              type="button"
              onClick={() => data.onDelete?.(id)}
              className="rounded-full bg-gray-900 p-1 text-red-400 shadow ring-1 ring-gray-700 hover:bg-red-900/30"
              title="Edge löschen"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function pillClass(branch: string): string {
  const map: Record<string, string> = {
    success: 'bg-green-900/60 text-green-300',
    failure: 'bg-red-900/60 text-red-300',
    custom: 'bg-violet-900/60 text-violet-300',
  };
  return `rounded px-1.5 py-0.5 text-[10px] font-medium ${map[branch] ?? 'bg-gray-800 text-gray-300'} shadow ring-1 ring-gray-700`;
}
