import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  useNodesState, useEdgesState, addEdge, Connection, Edge, Node,
  useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import { ArrowLeft, Save, Play, CheckCircle, Pause, Trash2, PanelLeftOpen, PanelRightOpen, X } from 'lucide-react';

import { workflowsApi, WorkflowDefinition, WorkflowNode as WfNode, WorkflowEdge as WfEdge, WorkflowStatus, WorkflowNodeMetadata } from '../api/workflows';
import { errorMessage, isRecord, isUnknownArray, optionOr } from '../lib/narrow';
import { WorkflowCanvas } from '../components/workflows/WorkflowCanvas';
import { WorkflowNodePalette } from '../components/workflows/WorkflowNodePalette';
import { WorkflowNodeInspector } from '../components/workflows/WorkflowNodeInspector';
import { WorkflowValidationBanner } from '../components/workflows/WorkflowValidationBanner';
import { WorkflowRunInspector } from '../components/workflows/WorkflowRunInspector';
import { WorkflowEditorMobileFallback } from '../components/workflows/WorkflowEditorMobileFallback';
import { useNodeTypesCatalog } from '../hooks/useNodeTypesCatalog';
import { useViewportBreakpoint, ViewportBreakpoint } from '../hooks/useViewportBreakpoint';
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

/** Erlaubte Branch-Werte einer Edge — Grundlage für `optionOr` statt Cast. */
const EDGE_BRANCHES = ['success', 'failure', 'custom', 'always'] as const;
type EdgeBranch = (typeof EDGE_BRANCHES)[number];

/**
 * xyflow führt `data` als `Record<string, unknown>`; was darin steht, weiss nur
 * diese Datei. Vorher stand an einem Dutzend Stellen `n.data as { type: string }`
 * — eine Behauptung, die bei einem Node ohne `data.type` (z.B. eine per
 * `onNodesChange` eingefügte Kopie) `undefined` als `string` weiterreichte und
 * erst weit später, im `byType[…]`-Lookup oder im Speichern-DTO, auffiel.
 */
interface NodeData {
  type: string;
  label?: string;
  config: Record<string, unknown>;
  secretRefs?: string[];
}

function readStringArray(value: unknown): string[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  return value.filter((entry) => typeof entry === 'string');
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function readNodeData(data: unknown): NodeData {
  if (!isRecord(data)) return { type: '', config: {} };
  return {
    type: typeof data.type === 'string' ? data.type : '',
    label: typeof data.label === 'string' ? data.label : undefined,
    config: isRecord(data.config) ? data.config : {},
    secretRefs: readStringArray(data.secretRefs),
  };
}

interface EdgeData {
  branch: EdgeBranch;
  condition?: Record<string, unknown>;
  payloadMapping?: Record<string, string>;
}

function readEdgeData(data: unknown): EdgeData {
  if (!isRecord(data)) return { branch: 'always' };
  return {
    branch: typeof data.branch === 'string' ? optionOr(data.branch, EDGE_BRANCHES, 'always') : 'always',
    condition: isRecord(data.condition) ? data.condition : undefined,
    payloadMapping: readStringRecord(data.payloadMapping),
  };
}

/**
 * Panel-Sichtbarkeit: Default ist „am Desktop offen". Ein Klick auf Öffnen /
 * Schliessen hinterlegt eine Ausnahme, die nur für den Breakpoint gilt, in dem
 * sie gesetzt wurde — ein Wechsel Tablet↔Desktop fällt also auf den Default
 * zurück, wie zuvor der Effect.
 */
type PanelOverride = { bp: ViewportBreakpoint; open: boolean } | null;

function panelOpen(override: PanelOverride, bp: ViewportBreakpoint): boolean {
  return override !== null && override.bp === bp ? override.open : bp === 'desktop';
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
  const [paletteOverride, setPaletteOverride] = useState<PanelOverride>(null);
  const [inspectorOverride, setInspectorOverride] = useState<PanelOverride>(null);
  const draggedTypeRef = useRef<string | null>(null);

  const paletteOpen = panelOpen(paletteOverride, bp);
  const inspectorOpen = panelOpen(inspectorOverride, bp);
  const setPaletteOpen = (open: boolean) => setPaletteOverride({ bp, open });
  const setInspectorOpen = (open: boolean) => setInspectorOverride({ bp, open });

  useWorkflowDirtyGuard(dirty);

  // Der Toast-Kontext liefert bei jedem Provider-Render ein neues Objekt. Als
  // Dependency des Lade-Effects wäre das eine Schleife: Fehler → Toast →
  // Provider-Render → neuer Kontext → erneutes Laden → Fehler.
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  useEffect(() => {
    let cancelled = false;
    workflowsApi.get(id).then((wf) => {
      if (cancelled) return;
      setWorkflow(wf);
      setNodes(wf.nodes.map((n) => toReactFlowNode(n, byType)));
      setEdges(wf.edges.map(toReactFlowEdge));
    }).catch((err: unknown) => {
      toastRef.current.showError(`Workflow nicht ladbar: ${errorMessage(err)}`);
    });
    return () => { cancelled = true; };
  }, [id, byType, setNodes, setEdges]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((e) => e.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);

  const onConnect = useCallback((conn: Connection) => {
    const branch = optionOr(conn.sourceHandle ?? 'always', EDGE_BRANCHES, 'always');
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
      const newId = generateNodeId(readNodeData(orig.data).type || 'node', ns.map((n) => n.id));
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
  }, [handleDeleteNode, handleDuplicateNode, handleDeleteEdge, setNodes, setEdges]);

  const addNodeOfType = useCallback((type: string, position: { x: number; y: number }) => {
    const meta = byType[type];
    if (!meta) return;
    setNodes((ns) => {
      const newId = generateNodeId(type, ns.map((n) => n.id));
      const defaults = getDefaultsFromJsonSchema(meta.configJsonSchema);
      const newNode: Node = {
        id: newId,
        type: 'workflowNode',
        position,
        data: {
          type,
          config: isRecord(defaults) ? defaults : {},
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

  const handleSave = useCallback(async (extra: Partial<UpdateDto> = {}, silent = false): Promise<boolean> => {
    if (!workflow) return false;
    setSaving(true);
    try {
      const dto: UpdateDto = {
        nodes: nodes.map((n) => {
          const d = readNodeData(n.data);
          return {
            id: n.id,
            type: d.type,
            position: n.position,
            config: d.config,
            secretRefs: d.secretRefs ?? [],
          };
        }),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourcePort: e.sourceHandle ?? undefined,
          targetPort: e.targetHandle ?? undefined,
          branch: readEdgeData(e.data).branch,
        })),
        ...extra,
      };
      const updated = await workflowsApi.update(id, dto);
      setWorkflow(updated);
      setRemoteIssues([]);
      setDirty(false);
      if (!silent) toast.showSuccess('Workflow gespeichert');
      return true;
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.toLowerCase().includes('cannot') || msg.includes('400')) {
        setRemoteIssues(parseValidationIssues(msg));
      }
      toast.showError(`Speichern fehlgeschlagen: ${msg}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [workflow, nodes, edges, id, toast]);

  // Auto-save: when dirty is set (typically from drag/drop/connect),
  // wait 800ms of idle and then silently persist the current state.
  // Manual changes via the Save button or Activate stay explicit and toast-confirmed.
  const handleSaveRef = useRef(handleSave);
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  useEffect(() => {
    if (!dirty || saving) return;
    const timer = setTimeout(() => {
      void handleSaveRef.current({}, true);
    }, 800);
    return () => clearTimeout(timer);
  }, [dirty, saving]);

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
      toast.showError(`Run fehlgeschlagen: ${errorMessage(err)}`);
    }
  };

  const handleStatusChange = async (status: WorkflowStatus) => {
    try {
      const updated = await workflowsApi.update(id, { status });
      setWorkflow(updated);
      toast.showSuccess(`Status: ${status}`);
    } catch (err) {
      toast.showError(errorMessage(err, 'Status nicht änderbar'));
    }
  };

  const handleDelete = async () => {
    if (!confirm('Workflow wirklich löschen?')) return;
    try {
      await workflowsApi.delete(id);
      toast.showSuccess('Workflow gelöscht');
      void navigate('/workflows');
    } catch (err) {
      toast.showError(errorMessage(err, 'Löschen fehlgeschlagen'));
    }
  };

  const jumpToNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) void reactFlowApi.setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 400 });
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
        const d = readNodeData(n.data);
        return { id: n.id, type: d.type, config: d.config, secretRefs: d.secretRefs };
      });
  }, [nodes, edges, selectedNodeId]);

  const outgoingByBranch = useMemo(() => {
    if (!selectedNodeId) return {};
    const map: Record<string, number> = {};
    for (const e of edges) {
      if (e.source !== selectedNodeId) continue;
      const b = readEdgeData(e.data).branch;
      map[b] = (map[b] ?? 0) + 1;
    }
    return map;
  }, [edges, selectedNodeId]);

  // T-325: outgoing edges of the selected node — feed the new "Ausgabe an
  // nächste Nodes" summary section in the inspector.
  const outgoingEdgesForSelected = useMemo<WfEdge[]>(() => {
    if (!selectedNodeId) return [];
    return edges.filter((e) => e.source === selectedNodeId).map(edgeToWf);
  }, [edges, selectedNodeId]);

  // T-325: id → minimal node info for label rendering in the edge summary
  // and source-output lookup in the EdgeInspector.
  const nodesById = useMemo<Record<string, { id: string; type: string; label?: string }>>(() => {
    const out: Record<string, { id: string; type: string; label?: string }> = {};
    for (const n of nodes) {
      const d = readNodeData(n.data);
      out[n.id] = { id: n.id, type: d.type, label: d.label };
    }
    return out;
  }, [nodes]);

  const selectedNodeData = useMemo(() => readNodeData(selectedNode?.data), [selectedNode]);

  const localIssues = useMemo(() => {
    if (!selectedNode) return [];
    const meta = byType[selectedNodeData.type];
    if (!meta) return ['Unbekannter Type — Schema nicht geladen.'];
    const issues: string[] = [];
    const required = readStringArray(meta.configJsonSchema.required) ?? [];
    const cfg = selectedNodeData.config;
    for (const r of required) {
      const v = cfg[r];
      if (v === undefined || v === null || v === '') issues.push(`config.${r}: required`);
    }
    return issues;
  }, [selectedNode, selectedNodeData, byType]);

  if (!workflow) {
    return <div className="container mx-auto p-6 text-sm text-gray-500">Lädt…</div>;
  }

  if (bp === 'phone') {
    return (
      <WorkflowEditorMobileFallback
        workflow={workflow}
        onActivate={() => { void handleActivate(); }}
        onRun={() => { void handleRun(); }}
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
          <button onClick={() => { void handleSave(); }} disabled={saving} className="inline-flex items-center gap-1 rounded bg-gray-800 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50">
            <Save size={12} /> Speichern
          </button>
          {workflow.status !== 'active' && (
            <button onClick={() => { void handleActivate(); }} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-1 text-xs text-white hover:bg-cyan-500">
              <CheckCircle size={12} /> Aktivieren
            </button>
          )}
          {workflow.status === 'active' && (
            <>
              <button onClick={() => { void handleRun(); }} className="inline-flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-500">
                <Play size={12} /> Run
              </button>
              <button onClick={() => { void handleStatusChange('paused'); }} className="inline-flex items-center gap-1 rounded bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-600">
                <Pause size={12} /> Pause
              </button>
            </>
          )}
          <button onClick={() => { void handleDelete(); }} className="inline-flex items-center gap-1 rounded bg-red-900/60 px-3 py-1 text-xs text-red-200 hover:bg-red-900">
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
              // Mark dirty for finished position changes (drag-end) AND structural changes
              // (remove, dimensions etc). xyflow v12 sometimes leaves dragging undefined
              // at drag-end, so we treat anything-but-true as "settled".
              if (changes.some((c) =>
                (c.type === 'position' && c.dragging !== true) ||
                c.type === 'remove' ||
                c.type === 'add' ||
                c.type === 'replace'
              )) {
                setDirty(true);
              }
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              if (changes.some((c) => c.type === 'remove' || c.type === 'add' || c.type === 'replace')) {
                setDirty(true);
              }
            }}
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
                type: selectedNodeData.type,
                config: selectedNodeData.config,
                secretRefs: selectedNodeData.secretRefs,
              } : null}
              selectedEdge={selectedEdge ? edgeToWf(selectedEdge) : null}
              catalog={catalog}
              upstreamNodes={upstreamNodes}
              outgoingEdgeCountByBranch={outgoingByBranch}
              outgoingEdges={outgoingEdgesForSelected}
              nodesById={nodesById}
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
                const defaults = getDefaultsFromJsonSchema(meta.configJsonSchema);
                const defaultConfig = isRecord(defaults) ? defaults : {};
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
              onSelectEdge={(eid) => {
                setSelectedNodeId(null);
                setSelectedEdgeId(eid);
              }}
              onChangeEdgePayloadMapping={(eid, mapping) => {
                setEdges((es) => es.map((e) => e.id === eid ? { ...e, data: { ...e.data, payloadMapping: mapping } } : e));
                setDirty(true);
              }}
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

      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} onNavigate={setRunId} />}
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
    data: { branch: e.branch ?? 'always', condition: e.condition, payloadMapping: e.payloadMapping },
  };
}

function edgeToWf(e: Edge): WfEdge {
  const d = readEdgeData(e.data);
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourcePort: e.sourceHandle ?? undefined,
    targetPort: e.targetHandle ?? undefined,
    branch: d.branch,
    condition: d.condition,
    payloadMapping: d.payloadMapping,
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
