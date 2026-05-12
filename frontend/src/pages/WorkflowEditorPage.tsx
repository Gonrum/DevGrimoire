import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  useNodesState, useEdgesState, addEdge, Connection, Edge, Node,
  useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import { ArrowLeft, Save, Play, CheckCircle, Pause, Trash2, PanelLeftOpen, PanelRightOpen, X } from 'lucide-react';

import { workflowsApi, WorkflowDefinition, WorkflowNode as WfNode, WorkflowEdge as WfEdge, WorkflowStatus, WorkflowNodeMetadata } from '../api/workflows';
import { WorkflowCanvas } from '../components/workflows/WorkflowCanvas';
import { WorkflowNodePalette } from '../components/workflows/WorkflowNodePalette';
import { WorkflowNodeInspector } from '../components/workflows/WorkflowNodeInspector';
import { WorkflowValidationBanner } from '../components/workflows/WorkflowValidationBanner';
import { WorkflowRunInspector } from '../components/workflows/WorkflowRunInspector';
import { WorkflowEditorMobileFallback } from '../components/workflows/WorkflowEditorMobileFallback';
import { useNodeTypesCatalog } from '../hooks/useNodeTypesCatalog';
import { useViewportBreakpoint } from '../hooks/useViewportBreakpoint';
import { useWorkflowDirtyGuard } from '../hooks/useWorkflowDirtyGuard';
import { parseValidationIssues, RemoteIssue } from '../components/workflows/parseValidationIssues';
import { getDefaultsFromJsonSchema } from '../components/workflows/schemaDefaults';
import { generateNodeId } from '../components/workflows/generateNodeId';
import { useToast } from '../components/Toast';

export default function WorkflowEditorPage() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}

function EditorInner() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { catalog, byType } = useNodeTypesCatalog();
  const bp = useViewportBreakpoint();
  const reactFlowApi = useReactFlow();

  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [remoteIssues, setRemoteIssues] = useState<RemoteIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(bp === 'desktop');
  const [inspectorOpen, setInspectorOpen] = useState(bp === 'desktop');
  const draggedTypeRef = useRef<string | null>(null);

  useWorkflowDirtyGuard(dirty);

  useEffect(() => {
    let cancelled = false;
    workflowsApi.get(id).then((wf) => {
      if (cancelled) return;
      setWorkflow(wf);
      setNodes(wf.nodes.map((n) => toReactFlowNode(n, byType)));
      setEdges(wf.edges.map(toReactFlowEdge));
    }).catch((err) => {
      toast.showError(`Workflow nicht ladbar: ${(err as Error).message}`);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, byType]);

  useEffect(() => {
    setPaletteOpen(bp === 'desktop');
    setInspectorOpen(bp === 'desktop' && !!selectedNodeId);
  }, [bp, selectedNodeId]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((e) => e.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);

  const onConnect = useCallback((conn: Connection) => {
    const branch = (conn.sourceHandle ?? 'always') as 'success' | 'failure' | 'custom' | 'always';
    const newId = `e_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    setEdges((eds) => addEdge({
      ...conn,
      id: newId,
      type: 'workflowEdge',
      data: { branch },
    }, eds));
    setDirty(true);
  }, [setEdges]);

  const handleDeleteNode = useCallback((nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    setSelectedNodeId((cur) => (cur === nid ? null : cur));
    setDirty(true);
  }, [setNodes, setEdges]);

  const handleDuplicateNode = useCallback((nid: string) => {
    setNodes((ns) => {
      const orig = ns.find((n) => n.id === nid);
      if (!orig) return ns;
      const data = orig.data as { type?: string };
      const newId = generateNodeId(data.type ?? 'node', ns.map((n) => n.id));
      const newNode: Node = {
        ...orig,
        id: newId,
        position: { x: orig.position.x + 40, y: orig.position.y + 40 },
        selected: false,
      };
      return [...ns, newNode];
    });
    setDirty(true);
  }, [setNodes]);

  const handleDeleteEdge = useCallback((eid: string) => {
    setEdges((es) => es.filter((e) => e.id !== eid));
    setSelectedEdgeId((cur) => (cur === eid ? null : cur));
    setDirty(true);
  }, [setEdges]);

  // Inject handlers into node/edge data after handlers are stable
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({
      ...n,
      data: { ...n.data, onDelete: handleDeleteNode, onDuplicate: handleDuplicateNode },
    })));
    setEdges((es) => es.map((e) => ({
      ...e,
      data: { ...e.data, onDelete: handleDeleteEdge },
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleDeleteNode, handleDuplicateNode, handleDeleteEdge]);

  const addNodeOfType = useCallback((type: string, position: { x: number; y: number }) => {
    const meta = byType[type];
    if (!meta) return;
    setNodes((ns) => {
      const newId = generateNodeId(type, ns.map((n) => n.id));
      const defaultConfig = getDefaultsFromJsonSchema(meta.configJsonSchema) as Record<string, unknown> | undefined;
      const newNode: Node = {
        id: newId,
        type: 'workflowNode',
        position,
        data: {
          type,
          config: defaultConfig ?? {},
          secretRefs: [],
          metadata: meta,
          onDelete: handleDeleteNode,
          onDuplicate: handleDuplicateNode,
        },
      };
      return [...ns, newNode];
    });
    setDirty(true);
  }, [byType, setNodes, handleDeleteNode, handleDuplicateNode]);

  const handleDrop = useCallback((event: React.DragEvent, position: { x: number; y: number }) => {
    const type = event.dataTransfer.getData('application/x-workflow-node-type');
    if (!type) return;
    addNodeOfType(type, position);
  }, [addNodeOfType]);

  const handlePaletteDragStart = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData('application/x-workflow-node-type', type);
    e.dataTransfer.effectAllowed = 'move';
    draggedTypeRef.current = type;
  };

  const handlePaletteTap = (type: string) => {
    // Tablet/touch path: place at center of viewport for simplicity.
    addNodeOfType(type, { x: 200, y: 200 });
    toast.showSuccess(`${type} platziert`);
  };

  type UpdateDto = {
    nodes: WfNode[];
    edges: WfEdge[];
    status?: WorkflowStatus;
  };

  const handleSave = useCallback(async (extra: Partial<UpdateDto> = {}): Promise<boolean> => {
    if (!workflow) return false;
    setSaving(true);
    try {
      const dto: UpdateDto = {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.data as { type: string }).type,
          position: n.position,
          config: (n.data as { config?: Record<string, unknown> }).config ?? {},
          secretRefs: (n.data as { secretRefs?: string[] }).secretRefs ?? [],
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourcePort: e.sourceHandle ?? undefined,
          targetPort: e.targetHandle ?? undefined,
          branch: ((e.data as { branch?: string })?.branch ?? 'always') as 'success' | 'failure' | 'custom' | 'always',
        })),
        ...extra,
      };
      const updated = await workflowsApi.update(id, dto);
      setWorkflow(updated);
      setRemoteIssues([]);
      setDirty(false);
      toast.showSuccess('Workflow gespeichert');
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.toLowerCase().includes('cannot') || msg.includes('400')) {
        setRemoteIssues(parseValidationIssues(msg));
      }
      toast.showError(`Speichern fehlgeschlagen: ${msg}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [workflow, nodes, edges, id, toast]);

  const handleActivate = async () => {
    const saved = await handleSave({ status: 'active' });
    if (saved) toast.showSuccess('Workflow aktiviert');
  };

  const handleRun = async () => {
    if (!workflow) return;
    try {
      const run = await workflowsApi.start(id);
      toast.showSuccess(`Run gestartet`);
      setRunId(run._id);
    } catch (err) {
      toast.showError(`Run fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  const handleStatusChange = async (status: WorkflowStatus) => {
    try {
      const updated = await workflowsApi.update(id, { status });
      setWorkflow(updated);
      toast.showSuccess(`Status: ${status}`);
    } catch (err) {
      toast.showError((err as Error).message);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Workflow wirklich löschen?')) return;
    try {
      await workflowsApi.delete(id);
      toast.showSuccess('Workflow gelöscht');
      navigate('/workflows');
    } catch (err) {
      toast.showError((err as Error).message);
    }
  };

  const jumpToNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) reactFlowApi.setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 400 });
  };

  const upstreamNodes = useMemo(() => {
    if (!selectedNodeId) return [];
    const incoming = new Set<string>();
    const stack: string[] = [selectedNodeId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) {
        if (e.target === cur && !incoming.has(e.source)) {
          incoming.add(e.source);
          stack.push(e.source);
        }
      }
    }
    return nodes
      .filter((n) => incoming.has(n.id))
      .map((n) => {
        const d = n.data as { type: string; config?: Record<string, unknown>; secretRefs?: string[] };
        return { id: n.id, type: d.type, config: d.config ?? {}, secretRefs: d.secretRefs };
      });
  }, [nodes, edges, selectedNodeId]);

  const outgoingByBranch = useMemo(() => {
    if (!selectedNodeId) return {};
    const map: Record<string, number> = {};
    for (const e of edges) {
      if (e.source !== selectedNodeId) continue;
      const b = (e.data as { branch?: string })?.branch ?? 'always';
      map[b] = (map[b] ?? 0) + 1;
    }
    return map;
  }, [edges, selectedNodeId]);

  const localIssues = useMemo(() => {
    if (!selectedNode) return [];
    const d = selectedNode.data as { type: string; config?: Record<string, unknown> };
    const meta = byType[d.type];
    if (!meta) return ['Unbekannter Type — Schema nicht geladen.'];
    const issues: string[] = [];
    const required = ((meta.configJsonSchema as { required?: string[] }).required ?? []);
    const cfg = d.config ?? {};
    for (const r of required) {
      const v = cfg[r];
      if (v === undefined || v === null || v === '') issues.push(`config.${r}: required`);
    }
    return issues;
  }, [selectedNode, byType]);

  if (!workflow) {
    return <div className="container mx-auto p-6 text-sm text-gray-500">Lädt…</div>;
  }

  if (bp === 'phone') {
    return (
      <WorkflowEditorMobileFallback
        workflow={workflow}
        onActivate={handleActivate}
        onRun={handleRun}
      />
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-gray-800 bg-gray-900 px-4 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/workflows" className="text-gray-400 hover:text-gray-200"><ArrowLeft size={16} /></Link>
          <span className="truncate text-sm font-semibold text-gray-200">{workflow.name}</span>
          <StatusPill status={workflow.status} />
          <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">v{workflow.version}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => handleSave()} disabled={saving} className="inline-flex items-center gap-1 rounded bg-gray-800 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50">
            <Save size={12} /> Speichern
          </button>
          {workflow.status !== 'active' && (
            <button onClick={handleActivate} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-1 text-xs text-white hover:bg-cyan-500">
              <CheckCircle size={12} /> Aktivieren
            </button>
          )}
          {workflow.status === 'active' && (
            <>
              <button onClick={handleRun} className="inline-flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-500">
                <Play size={12} /> Run
              </button>
              <button onClick={() => handleStatusChange('paused')} className="inline-flex items-center gap-1 rounded bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-600">
                <Pause size={12} /> Pause
              </button>
            </>
          )}
          <button onClick={handleDelete} className="inline-flex items-center gap-1 rounded bg-red-900/60 px-3 py-1 text-xs text-red-200 hover:bg-red-900">
            <Trash2 size={12} />
          </button>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {(bp === 'desktop' || paletteOpen) ? (
          <aside className={`${bp === 'desktop' ? 'w-[260px]' : 'absolute z-20 h-full w-[260px]'}`}>
            <WorkflowNodePalette
              catalog={catalog}
              workflowScope={workflow.scope}
              onDragStart={handlePaletteDragStart}
              onTapPlace={handlePaletteTap}
              touchMode={bp === 'tablet'}
            />
          </aside>
        ) : (
          <button onClick={() => setPaletteOpen(true)} className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-r bg-gray-800 p-2 text-gray-300 hover:bg-gray-700">
            <PanelLeftOpen size={20} />
          </button>
        )}
        {bp === 'tablet' && paletteOpen && (
          <button onClick={() => setPaletteOpen(false)} className="absolute left-[252px] top-2 z-30 rounded bg-gray-800 p-1 text-gray-300"><X size={14} /></button>
        )}

        <main className="flex-1">
          <WorkflowCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((c) => c.type === 'position' && c.dragging === false)) setDirty(true);
            }}
            onEdgesChange={(changes) => { onEdgesChange(changes); setDirty(true); }}
            onConnect={onConnect}
            onSelectionChange={(sel) => {
              setSelectedNodeId(sel.nodes[0]?.id ?? null);
              setSelectedEdgeId(sel.edges[0]?.id ?? null);
              if (bp === 'tablet' && (sel.nodes[0] || sel.edges[0])) setInspectorOpen(true);
            }}
            onDrop={handleDrop}
          />
        </main>

        {(bp === 'desktop' || inspectorOpen) ? (
          <aside className={`${bp === 'desktop' ? 'w-[320px]' : 'absolute right-0 z-20 h-full w-[320px]'}`}>
            <WorkflowNodeInspector
              selectedNode={selectedNode ? {
                id: selectedNode.id,
                type: (selectedNode.data as { type: string }).type,
                config: ((selectedNode.data as { config?: Record<string, unknown> }).config) ?? {},
                secretRefs: (selectedNode.data as { secretRefs?: string[] }).secretRefs,
              } : null}
              selectedEdge={selectedEdge ? edgeToWf(selectedEdge) : null}
              catalog={catalog}
              upstreamNodes={upstreamNodes}
              outgoingEdgeCountByBranch={outgoingByBranch}
              localIssues={localIssues}
              onChangeConfig={(cfg) => {
                if (!selectedNodeId) return;
                setNodes((ns) => ns.map((n) => n.id === selectedNodeId ? { ...n, data: { ...n.data, config: cfg } } : n));
                setDirty(true);
              }}
              onRenameNode={() => { /* follow-up */ }}
              onChangeNodeType={(newType) => {
                if (!selectedNodeId) return;
                const meta = byType[newType];
                if (!meta) return;
                const defaultConfig = (getDefaultsFromJsonSchema(meta.configJsonSchema) as Record<string, unknown>) ?? {};
                setNodes((ns) => ns.map((n) => n.id === selectedNodeId ? { ...n, data: { ...n.data, type: newType, metadata: meta, config: defaultConfig } } : n));
                setDirty(true);
              }}
              onDeleteNode={() => selectedNodeId && handleDeleteNode(selectedNodeId)}
              onDuplicateNode={() => selectedNodeId && handleDuplicateNode(selectedNodeId)}
              onChangeEdgeBranch={(branch) => {
                if (!selectedEdgeId) return;
                setEdges((es) => es.map((e) => e.id === selectedEdgeId ? { ...e, sourceHandle: branch === 'always' ? null : branch, data: { ...e.data, branch } } : e));
                setDirty(true);
              }}
              onDeleteEdge={() => selectedEdgeId && handleDeleteEdge(selectedEdgeId)}
            />
          </aside>
        ) : (
          <button onClick={() => setInspectorOpen(true)} className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-l bg-gray-800 p-2 text-gray-300 hover:bg-gray-700">
            <PanelRightOpen size={20} />
          </button>
        )}
        {bp === 'tablet' && inspectorOpen && (
          <button onClick={() => setInspectorOpen(false)} className="absolute right-[312px] top-2 z-30 rounded bg-gray-800 p-1 text-gray-300"><X size={14} /></button>
        )}
      </div>

      <WorkflowValidationBanner
        issues={remoteIssues}
        onJumpTo={jumpToNode}
        onDismiss={() => setRemoteIssues([])}
      />

      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} />}
    </div>
  );
}

function toReactFlowNode(n: WfNode, byType: Record<string, WorkflowNodeMetadata>): Node {
  return {
    id: n.id,
    type: 'workflowNode',
    position: n.position,
    data: {
      type: n.type,
      config: n.config ?? {},
      secretRefs: n.secretRefs ?? [],
      metadata: byType[n.type],
    },
  };
}

function toReactFlowEdge(e: WfEdge): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourcePort ?? (e.branch && e.branch !== 'always' ? e.branch : null),
    targetHandle: e.targetPort ?? null,
    type: 'workflowEdge',
    data: { branch: e.branch ?? 'always', condition: e.condition },
  };
}

function edgeToWf(e: Edge): WfEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourcePort: e.sourceHandle ?? undefined,
    targetPort: e.targetHandle ?? undefined,
    branch: ((e.data as { branch?: WfEdge['branch'] })?.branch ?? 'always') as WfEdge['branch'],
    condition: (e.data as { condition?: Record<string, unknown> })?.condition,
  };
}

function StatusPill({ status }: { status: WorkflowStatus }) {
  const map: Record<WorkflowStatus, string> = {
    draft: 'bg-gray-700 text-gray-200',
    active: 'bg-green-900/60 text-green-200',
    paused: 'bg-amber-900/60 text-amber-200',
    archived: 'bg-gray-800 text-gray-500',
  };
  return <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${map[status]}`}>{status}</span>;
}
