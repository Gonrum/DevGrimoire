import type { KgEntityType } from '../../api/client';

interface NodePoint {
  id: string;
  entityType: KgEntityType;
  label: string;
}

interface LayoutNode {
  id: string;
  entityType: KgEntityType;
  label: string;
  x: number;
  y: number;
}

/**
 * Layouts a set of typed nodes in a "type cluster" arrangement:
 * each entity type gets a fixed slot on a big circle. Within the slot the
 * nodes of that type are arranged on a smaller circle (or stacked when only
 * one). The result is deterministic and produces readable graphs without
 * needing a force simulation.
 */
export function layoutTypeClusters(nodes: NodePoint[], options?: {
  outerRadius?: number;
  clusterRadius?: number;
  focalId?: string;
}): LayoutNode[] {
  const outerRadius = options?.outerRadius ?? 480;
  const clusterRadius = options?.clusterRadius ?? 110;

  // Group by entityType, keep stable order
  const byType = new Map<KgEntityType, NodePoint[]>();
  for (const n of nodes) {
    if (!byType.has(n.entityType)) byType.set(n.entityType, []);
    byType.get(n.entityType)!.push(n);
  }
  const types = Array.from(byType.keys()).sort();

  const result: LayoutNode[] = [];
  const total = types.length;

  // Focal node (if any) → place near origin and exclude from its cluster centering
  const focalIndex = options?.focalId ? nodes.findIndex((n) => n.id === options.focalId) : -1;
  if (focalIndex >= 0) {
    const focal = nodes[focalIndex];
    result.push({ ...focal, x: 0, y: 0 });
  }

  types.forEach((type, ti) => {
    const angle = (2 * Math.PI * ti) / Math.max(1, total) - Math.PI / 2; // start at top
    const cx = Math.cos(angle) * outerRadius;
    const cy = Math.sin(angle) * outerRadius;
    const list = byType.get(type)!.filter((n) => n.id !== options?.focalId);
    if (list.length === 0) return;
    if (list.length === 1) {
      result.push({ ...list[0], x: cx, y: cy });
      return;
    }
    // arrange on small circle around (cx,cy)
    list.forEach((n, ni) => {
      const innerAngle = (2 * Math.PI * ni) / list.length;
      const radius = clusterRadius + Math.min(60, list.length * 4);
      result.push({
        ...n,
        x: cx + Math.cos(innerAngle) * radius,
        y: cy + Math.sin(innerAngle) * radius,
      });
    });
  });

  return result;
}
