import { memo } from 'react';
import { Handle, Position, NodeToolbar, NodeProps } from '@xyflow/react';
import { AlertTriangle, Copy, Trash2 } from 'lucide-react';
import { WorkflowNodeMetadata, WorkflowNodeRunStatus } from '../../api/workflows';
import { nodeCategoryStyles } from './nodeCategoryStyles';
import { getNodeIcon } from './nodeTypeIconMap';
import { runStatusStyles } from './runStatusStyles';

export interface WorkflowNodeData {
  type: string;
  config: Record<string, unknown>;
  secretRefs?: string[];
  metadata?: WorkflowNodeMetadata;
  runStatus?: WorkflowNodeRunStatus;
  issueCount?: number;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  [key: string]: unknown;
}

function WorkflowCustomNodeImpl(props: NodeProps) {
  const data = props.data as WorkflowNodeData;
  const meta = data.metadata;
  const category = meta?.category ?? 'action';
  const style = nodeCategoryStyles[category];
  const Icon = getNodeIcon(data.type);
  const status = runStatusStyles[data.runStatus ?? 'idle'];
  const isTrigger = category === 'trigger';
  const branches = meta?.branches ?? ['success'];
  const issueCount = data.issueCount ?? 0;

  return (
    <>
      <NodeToolbar isVisible={props.selected} position={Position.Top} offset={8}>
        <div className="flex gap-1 rounded border border-gray-700 bg-gray-900 p-1 shadow-lg">
          <button
            type="button"
            title="Duplizieren"
            onClick={() => data.onDuplicate?.(props.id)}
            className="rounded p-1 text-gray-300 hover:bg-gray-800 hover:text-cyan-300"
          ><Copy size={14} /></button>
          <button
            type="button"
            title="Löschen"
            onClick={() => data.onDelete?.(props.id)}
            className="rounded p-1 text-gray-300 hover:bg-gray-800 hover:text-red-400"
          ><Trash2 size={14} /></button>
        </div>
      </NodeToolbar>

      <div
        className={`min-w-[220px] rounded-lg border-2 bg-gray-900 shadow-md ${style.border} ${status.ring} ${props.selected ? 'ring-offset-2 ring-offset-gray-950' : ''}`}
      >
        {!isTrigger && <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-gray-500" />}

        <div className={`flex items-center justify-between rounded-t px-3 py-2 ${style.headerBg}`}>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${status.dotBg}`} />
            <Icon size={14} className="text-gray-300" />
            <span className="font-mono text-xs text-gray-300">{data.type}</span>
          </div>
          {issueCount > 0 && (
            <span title={`${issueCount} Konfigurations-Issues`} className="text-amber-400">
              <AlertTriangle size={14} />
            </span>
          )}
        </div>

        <div className="px-3 py-2">
          <div className="text-xs text-gray-500">id: <span className="font-mono text-gray-300">{props.id}</span></div>
          <div className="mt-1 text-sm text-gray-200">{meta?.label ?? data.type}</div>
        </div>

        <div className="border-t border-gray-800 px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">
          branches
        </div>
        <div className="flex flex-col px-3 pb-2">
          {branches.map((branch) => (
            <div key={branch} className="relative flex items-center justify-end text-xs py-1 pr-2">
              <span className={branchPillClass(branch)}>{branch}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={branch}
                className="!h-2 !w-2 !bg-gray-500"
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function branchPillClass(branch: string): string {
  if (branch === 'success') return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-900/40 text-green-300';
  if (branch === 'failure') return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-900/40 text-red-300';
  if (branch === 'custom') return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-900/40 text-violet-300';
  return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-gray-800 text-gray-400';
}

export const WorkflowCustomNode = memo(WorkflowCustomNodeImpl);
