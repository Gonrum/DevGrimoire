import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ENTITY_TYPE_COLORS } from './entityTypeStyles';
import type { KgEntityType } from '../../api/client';

type Data = {
  label: string;
  entityType: KgEntityType;
  isFocal?: boolean;
};

export function KnowledgeGraphNode({ data, selected }: NodeProps) {
  const d = data as unknown as Data;
  const colors = ENTITY_TYPE_COLORS[d.entityType] ?? ENTITY_TYPE_COLORS.session;
  return (
    <div
      className="rounded px-2 py-1 text-xs shadow border"
      style={{
        background: colors.bg,
        color: colors.text,
        borderColor: selected || d.isFocal ? '#fde68a' : colors.border,
        borderWidth: selected || d.isFocal ? 2 : 1,
        minWidth: 110,
        maxWidth: 220,
      }}
    >
      <div className="text-[10px] uppercase opacity-60 tracking-wide">{d.entityType}</div>
      <div className="truncate font-medium leading-tight" title={d.label}>{d.label}</div>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
