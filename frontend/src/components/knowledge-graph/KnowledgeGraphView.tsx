import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  api,
  KnowledgeGraphEdge,
  KnowledgeGraphImpact,
  KgEntityType,
  KgRelation,
} from '../../api/client';
import { useToast } from '../Toast';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { layoutTypeClusters } from './layout';
import { ENTITY_TYPE_COLORS, RELATION_COLORS, entityHref } from './entityTypeStyles';
import { KnowledgeGraphNode } from './KnowledgeGraphNode';

interface Props {
  projectId: string;
  basePath: string;
}

const nodeTypes = { kgNode: KnowledgeGraphNode };

type Filter = {
  entityTypes: Set<KgEntityType>;
  relations: Set<KgRelation>;
  onlyConfirmed: boolean;
};

function buildGraph(edges: KnowledgeGraphEdge[], filter: Filter, focal?: { type: KgEntityType; id: string }) {
  const filtered = edges.filter((e) => {
    if (filter.onlyConfirmed && !e.userConfirmed) return false;
    if (filter.relations.size && !filter.relations.has(e.relation)) return false;
    if (
      filter.entityTypes.size &&
      !filter.entityTypes.has(e.source.entityType) &&
      !filter.entityTypes.has(e.target.entityType)
    ) {
      return false;
    }
    return true;
  });

  const nodeMap = new Map<string, { id: string; entityType: KgEntityType; label: string }>();
  const addNode = (entityType: KgEntityType, entityId: string, label?: string) => {
    const key = `${entityType}:${entityId}`;
    if (!nodeMap.has(key)) {
      nodeMap.set(key, { id: key, entityType, label: label || entityId.slice(-6) });
    } else if (label) {
      const existing = nodeMap.get(key)!;
      if (existing.label === entityId.slice(-6)) existing.label = label;
    }
  };
  for (const e of filtered) {
    addNode(e.source.entityType, e.source.entityId, e.source.label);
    addNode(e.target.entityType, e.target.entityId, e.target.label);
  }

  const focalKey = focal ? `${focal.type}:${focal.id}` : undefined;
  const laid = layoutTypeClusters(Array.from(nodeMap.values()), { focalId: focalKey });

  const rfNodes: Node[] = laid.map((n) => ({
    id: n.id,
    type: 'kgNode',
    position: { x: n.x, y: n.y },
    data: { label: n.label, entityType: n.entityType, isFocal: n.id === focalKey },
  }));

  const rfEdges: Edge[] = filtered.map((e) => {
    const color = RELATION_COLORS[e.relation] ?? '#64748b';
    return {
      id: e._id,
      source: `${e.source.entityType}:${e.source.entityId}`,
      target: `${e.target.entityType}:${e.target.entityId}`,
      label: e.relation,
      type: 'smoothstep',
      animated: !e.userConfirmed && e.createdBy === 'system' ? false : false,
      style: {
        stroke: color,
        strokeWidth: e.userConfirmed ? 2 : 1,
        strokeDasharray: e.userConfirmed ? undefined : '4 3',
      },
      labelStyle: { fontSize: 9, fill: color },
      labelBgStyle: { fill: '#0f172a', fillOpacity: 0.8 },
      labelBgPadding: [3, 2],
      labelBgBorderRadius: 2,
      markerEnd:
        e.direction === 'undirected'
          ? undefined
          : { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
    };
  });

  return { nodes: rfNodes, edges: rfEdges, filteredEdges: filtered };
}

const ALL_ENTITY_TYPES: KgEntityType[] = [
  'todo', 'milestone', 'knowledge', 'manual', 'research', 'schema',
  'feature', 'dependency', 'changelog', 'workflow', 'release', 'snippet',
  'commit', 'validation_report', 'doc_update_proposal', 'session',
];
const ALL_RELATIONS: KgRelation[] = [
  'belongs_to', 'completed_by', 'blocked_by', 'tagged_overlap', 'category_match',
  'validates', 'documents', 'depends_on', 'mentions', 'proposes_update', 'references',
];

export default function KnowledgeGraphView({ projectId, basePath }: Props) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [edges, setEdges] = useState<KnowledgeGraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [focal, setFocal] = useState<{ type: KgEntityType; id: string } | undefined>(undefined);
  const [impact, setImpact] = useState<KnowledgeGraphImpact | null>(null);
  const [filter, setFilter] = useState<Filter>({
    entityTypes: new Set(),
    relations: new Set(),
    onlyConfirmed: false,
  });

  const load = useCallback(() => {
    setLoading(true);
    api.knowledgeGraph
      .listEdges({ projectId, limit: 5000 })
      .then(setEdges)
      .catch((err) => showError((err as Error).message || 'Failed to load graph'))
      .finally(() => setLoading(false));
  }, [projectId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const graph = useMemo(() => buildGraph(edges, filter, focal), [edges, filter, focal]);

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const res = await api.knowledgeGraph.discover(projectId);
      showSuccess(t('knowledgeGraph.discovered', res as Record<string, number>));
      load();
    } catch (err) {
      showError((err as Error).message || 'Discover failed');
    } finally {
      setDiscovering(false);
    }
  };

  const handleNodeClick = useCallback(
    async (_: unknown, node: Node) => {
      const [type, id] = node.id.split(':', 2);
      setFocal({ type: type as KgEntityType, id });
      try {
        const imp = await api.knowledgeGraph.impact(projectId, type as KgEntityType, id, 2);
        setImpact(imp);
      } catch {
        setImpact(null);
      }
    },
    [projectId],
  );

  const handleEdgeDelete = async (edgeId: string) => {
    try {
      await api.knowledgeGraph.deleteEdge(edgeId);
      showSuccess(t('knowledgeGraph.edgeDeleted'));
      load();
    } catch (err) {
      showError((err as Error).message || 'Delete failed');
    }
  };

  const handleEdgeConfirm = async (edgeId: string, confirmed: boolean) => {
    try {
      await api.knowledgeGraph.confirmEdge(edgeId, confirmed);
      load();
    } catch (err) {
      showError((err as Error).message || 'Update failed');
    }
  };

  const toggleType = (type: KgEntityType) => {
    setFilter((f) => {
      const next = new Set(f.entityTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { ...f, entityTypes: next };
    });
  };
  const toggleRelation = (rel: KgRelation) => {
    setFilter((f) => {
      const next = new Set(f.relations);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return { ...f, relations: next };
    });
  };

  const focalEdges = useMemo(() => {
    if (!focal) return [] as KnowledgeGraphEdge[];
    return edges.filter(
      (e) =>
        (e.source.entityType === focal.type && e.source.entityId === focal.id) ||
        (e.target.entityType === focal.type && e.target.entityId === focal.id),
    );
  }, [edges, focal]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-400">
          {t('knowledgeGraph.totalEdges')}: <span className="text-cyan-300 font-medium">{edges.length}</span>
        </span>
        <span className="text-gray-600">·</span>
        <span className="text-gray-400">
          {t('knowledgeGraph.visible')}: <span className="text-gray-200">{graph.filteredEdges.length}</span>
        </span>
        <label className="flex items-center gap-1 ml-2 text-gray-400">
          <input
            type="checkbox"
            checked={filter.onlyConfirmed}
            onChange={(e) => setFilter((f) => ({ ...f, onlyConfirmed: e.target.checked }))}
            className="accent-cyan-500"
          />
          {t('knowledgeGraph.onlyConfirmed')}
        </label>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={discovering}
          onClick={handleDiscover}
          className="ml-auto"
        >
          {discovering ? t('knowledgeGraph.discovering') : t('knowledgeGraph.rebuild')}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3" style={{ minHeight: 600 }}>
        <aside className="lg:col-span-1 space-y-3 text-xs">
          <div className="bg-gray-900 border border-gray-800 rounded p-2">
            <div className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">
              {t('knowledgeGraph.filter.entityTypes')}
            </div>
            <div className="flex flex-wrap gap-1">
              {ALL_ENTITY_TYPES.map((type) => {
                const active = filter.entityTypes.has(type);
                const colors = ENTITY_TYPE_COLORS[type];
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleType(type)}
                    className="px-1.5 py-0.5 rounded border text-[10px]"
                    style={{
                      background: active ? colors.bg : 'transparent',
                      borderColor: colors.border,
                      color: active ? colors.text : colors.border,
                    }}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded p-2">
            <div className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">
              {t('knowledgeGraph.filter.relations')}
            </div>
            <div className="flex flex-wrap gap-1">
              {ALL_RELATIONS.map((rel) => {
                const active = filter.relations.has(rel);
                const color = RELATION_COLORS[rel];
                return (
                  <button
                    key={rel}
                    type="button"
                    onClick={() => toggleRelation(rel)}
                    className="px-1.5 py-0.5 rounded border text-[10px]"
                    style={{
                      background: active ? '#0f172a' : 'transparent',
                      borderColor: color,
                      color,
                    }}
                  >
                    {rel}
                  </button>
                );
              })}
            </div>
          </div>

          {focal && (
            <div className="bg-gray-900 border border-gray-800 rounded p-2">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-gray-500 text-[10px] uppercase">{focal.type}</div>
                  <div className="text-gray-200 font-medium truncate" title={focal.id}>
                    {edges.find(
                      (e) =>
                        (e.source.entityType === focal.type && e.source.entityId === focal.id) ||
                        (e.target.entityType === focal.type && e.target.entityId === focal.id),
                    )?.source.entityId === focal.id
                      ? edges.find(
                          (e) => e.source.entityType === focal.type && e.source.entityId === focal.id,
                        )?.source.label
                      : edges.find(
                          (e) => e.target.entityType === focal.type && e.target.entityId === focal.id,
                        )?.target.label || focal.id.slice(-6)}
                  </div>
                  {(() => {
                    const href = entityHref(basePath, focal.type, focal.id);
                    return href ? (
                      <Link to={href} className="text-[10px] text-cyan-400 hover:underline">
                        {t('knowledgeGraph.openEntity')} →
                      </Link>
                    ) : null;
                  })()}
                </div>
                <button
                  type="button"
                  className="text-gray-500 hover:text-gray-300 text-xs"
                  onClick={() => {
                    setFocal(undefined);
                    setImpact(null);
                  }}
                >
                  ✕
                </button>
              </div>

              <div className="text-gray-500 text-[10px] uppercase mb-1">
                {t('knowledgeGraph.directNeighbors')} ({focalEdges.length})
              </div>
              <ul className="space-y-1 max-h-48 overflow-auto">
                {focalEdges.map((e) => {
                  const isOutgoing =
                    e.source.entityType === focal.type && e.source.entityId === focal.id;
                  const other = isOutgoing ? e.target : e.source;
                  return (
                    <li
                      key={e._id}
                      className="flex items-start gap-1 text-[11px] border border-gray-800 rounded px-1 py-0.5"
                    >
                      <span
                        className="px-1 rounded text-[9px]"
                        style={{ color: RELATION_COLORS[e.relation] }}
                      >
                        {isOutgoing ? '→' : '←'} {e.relation}
                      </span>
                      <span className="flex-1 truncate" title={other.label || other.entityId}>
                        <span className="text-gray-500">[{other.entityType}]</span>{' '}
                        {other.label || other.entityId.slice(-6)}
                      </span>
                      {e.createdBy === 'system' && !e.userConfirmed && (
                        <button
                          type="button"
                          title={t('knowledgeGraph.confirmEdge')}
                          onClick={() => handleEdgeConfirm(e._id, true)}
                          className="text-green-400 hover:text-green-300"
                        >
                          ✓
                        </button>
                      )}
                      <button
                        type="button"
                        title={t('knowledgeGraph.deleteEdge')}
                        onClick={() => handleEdgeDelete(e._id)}
                        className="text-red-400 hover:text-red-300"
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
                {focalEdges.length === 0 && (
                  <li className="text-gray-600 italic">—</li>
                )}
              </ul>

              {impact && impact.reachable.length > 0 && (
                <>
                  <div className="text-gray-500 text-[10px] uppercase mt-2 mb-1">
                    {t('knowledgeGraph.impactDepth2')}
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {impact.reachable.length} {t('knowledgeGraph.reachable')}
                  </div>
                </>
              )}
            </div>
          )}
        </aside>

        <div
          className="lg:col-span-3 bg-gray-950 border border-gray-800 rounded"
          style={{ minHeight: 600 }}
        >
          {loading ? (
            <p className="text-sm text-gray-500 p-4">{t('common.loading')}</p>
          ) : graph.nodes.length === 0 ? (
            <div className="p-8">
              <EmptyState message={t('knowledgeGraph.empty')} />
              <p className="text-xs text-gray-600 mt-2">{t('knowledgeGraph.emptyHint')}</p>
            </div>
          ) : (
            <ReactFlowProvider>
              <div style={{ width: '100%', height: 600 }}>
                <ReactFlow
                  nodes={graph.nodes}
                  edges={graph.edges}
                  nodeTypes={nodeTypes}
                  onNodeClick={handleNodeClick}
                  fitView
                  fitViewOptions={{ padding: 0.15 }}
                  proOptions={{ hideAttribution: true }}
                  nodesDraggable
                  panOnDrag
                  zoomOnScroll
                >
                  <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1f2937" />
                  <Controls className="!bg-gray-900 !border-gray-700" />
                  <MiniMap
                    pannable
                    zoomable
                    className="!bg-gray-900"
                    nodeColor={(n) => {
                      const data = n.data as { entityType?: KgEntityType };
                      return data?.entityType ? ENTITY_TYPE_COLORS[data.entityType].border : '#374151';
                    }}
                    maskColor="rgba(15,23,42,0.7)"
                  />
                </ReactFlow>
              </div>
            </ReactFlowProvider>
          )}
        </div>
      </div>
    </div>
  );
}
