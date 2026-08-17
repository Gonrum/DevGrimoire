import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ENTITY_TYPE_COLORS } from './entityTypeStyles';
import type { KgEntityType } from '../../api/client';

type Data = {
  label: string;
  entityType: KgEntityType;
  isFocal?: boolean;
};

/** Der Knotentyp, den `buildGraph` in `KnowledgeGraphView` erzeugt. */
export type KgNode = Node<Data, 'kgNode'>;

/*
 * Vorher stand hier `data as unknown as Data` — eine doppelte Behauptung, die
 * jede Prüfung abschaltet. React Flow ist stattdessen über `NodeProps<KgNode>`
 * parametrisierbar: `data` ist damit von vornherein `Data`.
 */
export function KnowledgeGraphNode({ data: d, selected }: NodeProps<KgNode>) {
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
