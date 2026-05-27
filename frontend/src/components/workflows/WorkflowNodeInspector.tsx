import { useMemo } from 'react';
import { Trash2, Copy, ArrowRight, Plus, X } from 'lucide-react';
import { WorkflowNodeMetadata, WorkflowEdge as WfEdge } from '../../api/workflows';
import { SchemaField } from './SchemaField';
import { SchemaObjectAccordion } from './SchemaObjectAccordion';
import { TemplateOption } from './TemplatePicker';
import { nodeCategoryStyles } from './nodeCategoryStyles';

export interface SelectedNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  secretRefs?: string[];
}

interface Props {
  selectedNode: SelectedNode | null;
  selectedEdge: WfEdge | null;
  catalog: WorkflowNodeMetadata[];
  upstreamNodes: SelectedNode[];
  outgoingEdgeCountByBranch: Record<string, number>;
  /** T-325: outgoing edges of the currently selected node, used for the
   *  "Ausgabe an nächste Nodes" summary section. */
  outgoingEdges: WfEdge[];
  /** T-325: node lookup so the summary can show target labels and the
   *  edge inspector can pull source-side output keys. */
  nodesById: Record<string, { id: string; type: string; label?: string }>;
  localIssues: string[];
  onChangeConfig: (config: Record<string, unknown>) => void;
  onRenameNode: (oldId: string, newId: string) => void;
  onChangeNodeType: (newType: string) => void;
  onDeleteNode: () => void;
  onDuplicateNode: () => void;
  onChangeEdgeBranch: (branch: 'success' | 'failure' | 'custom' | 'always') => void;
  onDeleteEdge: () => void;
  /** T-325: click an outgoing-edge summary entry to switch to its EdgeInspector. */
  onSelectEdge: (edgeId: string) => void;
  /** T-325: update the per-edge payloadMapping (undefined = pass-through). */
  onChangeEdgePayloadMapping: (edgeId: string, mapping: Record<string, string> | undefined) => void;
}

export function WorkflowNodeInspector(props: Props) {
  const { selectedNode, selectedEdge } = props;

  if (!selectedNode && !selectedEdge) {
    return (
      <div className="flex h-full items-center justify-center border-l border-gray-800 bg-gray-950 p-6 text-sm text-gray-500">
        Wähle einen Node oder eine Edge aus, oder ziehe einen Eintrag aus der Palette.
      </div>
    );
  }

  if (selectedEdge) {
    const sourceNode = props.nodesById[selectedEdge.source];
    const sourceMeta = sourceNode ? props.catalog.find((c) => c.type === sourceNode.type) : undefined;
    const sourceOutputs = (sourceMeta?.outputs as Record<string, string>) ?? {};
    return (
      <EdgeInspector
        edge={selectedEdge}
        sourceOutputs={sourceOutputs}
        onChangeBranch={props.onChangeEdgeBranch}
        onChangePayloadMapping={(m) => props.onChangeEdgePayloadMapping(selectedEdge.id, m)}
        onDelete={props.onDeleteEdge}
      />
    );
  }

  return <NodeInspector {...props} />;
}

function NodeInspector(p: Props) {
  const { selectedNode, catalog, upstreamNodes, outgoingEdgeCountByBranch, localIssues } = p;
  const node = selectedNode!;
  const meta = catalog.find((c) => c.type === node.type);
  const cat = meta?.category ?? 'action';
  const style = nodeCategoryStyles[cat];

  const templateOptions = useMemo<TemplateOption[]>(() => {
    const opts: TemplateOption[] = [
      { path: 'input.event.entityId', label: 'event.entityId', type: 'string' },
      { path: 'input.event.entity', label: 'event.entity', type: 'string' },
      { path: 'input.event.action', label: 'event.action', type: 'string' },
    ];
    for (const up of upstreamNodes) {
      const upMeta = catalog.find((c) => c.type === up.type);
      if (!upMeta) continue;
      for (const [outKey, outType] of Object.entries(upMeta.outputs)) {
        opts.push({
          path: `nodes.${up.id}.${outKey}`,
          label: `${up.id} / ${outKey}`,
          type: outType,
        });
      }
    }
    return opts;
  }, [catalog, upstreamNodes]);

  return (
    <div className="flex h-full flex-col border-l border-gray-800 bg-gray-950">
      <div className={`border-b border-gray-800 px-4 py-3 ${style.headerBg}`}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-gray-300">id: {node.id}</span>
          <div className="flex gap-1">
            <button onClick={p.onDuplicateNode} title="Duplizieren" className="rounded p-1 text-gray-300 hover:bg-gray-800"><Copy size={14} /></button>
            <button onClick={p.onDeleteNode} title="Löschen" className="rounded p-1 text-gray-300 hover:bg-gray-800 hover:text-red-400"><Trash2 size={14} /></button>
          </div>
        </div>
        <div className="mt-1 text-sm text-gray-200">{meta?.label ?? node.type}</div>
        {meta?.description && <div className="mt-1 text-xs text-gray-500">{meta.description}</div>}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <section>
          <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Konfiguration</h3>
          {meta ? (
            (meta.configJsonSchema as { type?: string }).type === 'object' ? (
              <SchemaObjectAccordion
                schema={meta.configJsonSchema}
                value={node.config ?? {}}
                onChange={(v) => p.onChangeConfig(v)}
                templateOptions={templateOptions}
              />
            ) : (
              <SchemaField
                schema={meta.configJsonSchema}
                path={['config']}
                value={node.config}
                onChange={(v) => p.onChangeConfig(v as Record<string, unknown>)}
                templateOptions={templateOptions}
              />
            )
          ) : (
            <div className="text-xs text-amber-400">Unbekannter Node-Type — kein Schema verfügbar.</div>
          )}
        </section>

        {meta && Object.keys(meta.outputs).length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Outputs</h3>
            <ul className="text-xs">
              {Object.entries(meta.outputs).map(([k, t]) => (
                <li key={k} className="font-mono text-gray-400">• {k}: <span className="text-gray-500">{t}</span></li>
              ))}
            </ul>
          </section>
        )}

        {meta && meta.branches.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Branches</h3>
            <ul className="text-xs">
              {meta.branches.map((b) => (
                <li key={b} className="text-gray-400">○ {b} → {outgoingEdgeCountByBranch[b] ?? 0} outgoing</li>
              ))}
            </ul>
          </section>
        )}

        {p.outgoingEdges.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Ausgabe an nächste Nodes</h3>
            <ul className="space-y-1">
              {p.outgoingEdges.map((edge) => {
                const target = p.nodesById[edge.target];
                const targetLabel = target?.label || target?.id || edge.target;
                const mappingKeys = Object.keys(edge.payloadMapping ?? {});
                return (
                  <li key={edge.id}>
                    <button
                      type="button"
                      onClick={() => p.onSelectEdge(edge.id)}
                      className="flex w-full items-center justify-between gap-2 rounded border border-gray-800 bg-gray-900 px-2 py-1.5 text-left text-xs hover:border-cyan-700 hover:bg-gray-800"
                    >
                      <span className="flex items-center gap-1 text-gray-300">
                        <ArrowRight size={12} className="text-gray-500" />
                        <span className="font-mono">{targetLabel}</span>
                      </span>
                      <span className={mappingKeys.length > 0 ? 'text-cyan-300' : 'text-gray-500'}>
                        {mappingKeys.length > 0 ? `${mappingKeys.length} gemappt` : 'pass-through'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {localIssues.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-amber-400">⚠ Validierung</h3>
            <ul className="text-xs text-amber-300">
              {localIssues.map((iss, i) => <li key={i}>{iss}</li>)}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

interface EdgeInspectorProps {
  edge: WfEdge;
  sourceOutputs: Record<string, string>;
  onChangeBranch: (b: 'success' | 'failure' | 'custom' | 'always') => void;
  onChangePayloadMapping: (mapping: Record<string, string> | undefined) => void;
  onDelete: () => void;
}

function EdgeInspector({ edge, sourceOutputs, onChangeBranch, onChangePayloadMapping, onDelete }: EdgeInspectorProps) {
  const branches: Array<'success' | 'failure' | 'custom' | 'always'> = ['success', 'failure', 'custom', 'always'];
  const current = (edge.branch as 'success' | 'failure' | 'custom' | 'always') ?? 'always';
  const mapping = edge.payloadMapping ?? {};
  const isMapped = Object.keys(mapping).length > 0;
  const sourceKeys = Object.keys(sourceOutputs);

  const updateMappingKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChangePayloadMapping(next);
  };
  const updateMappingValue = (key: string, value: string) => {
    onChangePayloadMapping({ ...mapping, [key]: value });
  };
  const addRow = () => {
    // Find first source key not already mapped, or fall back to empty entry.
    const unused = sourceKeys.find((k) => !(k in mapping)) ?? '';
    const targetKey = unused || `field${Object.keys(mapping).length + 1}`;
    onChangePayloadMapping({ ...mapping, [targetKey]: unused });
  };
  const removeRow = (key: string) => {
    const next = { ...mapping };
    delete next[key];
    onChangePayloadMapping(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <div className="flex h-full flex-col border-l border-gray-800 bg-gray-950 p-4 overflow-y-auto">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Edge</h3>
      <div className="mb-3 text-xs text-gray-400 font-mono">{edge.source} → {edge.target}</div>
      <div className="mb-4">
        <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Branch</label>
        <div className="flex flex-wrap gap-1">
          {branches.map((b) => (
            <button key={b} onClick={() => onChangeBranch(b)} className={`rounded px-2 py-1 text-xs ${current === b ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>{b}</button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Payload-Mapping</label>
        <div className="mb-2 flex gap-1">
          <button
            type="button"
            onClick={() => onChangePayloadMapping(undefined)}
            className={`flex-1 rounded px-2 py-1 text-xs ${!isMapped ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            Pass-through
          </button>
          <button
            type="button"
            onClick={() => { if (!isMapped) addRow(); }}
            className={`flex-1 rounded px-2 py-1 text-xs ${isMapped ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            Felder mappen
          </button>
        </div>
        {!isMapped ? (
          <p className="text-xs text-gray-500">
            Target sieht das vollständige Source-Output unter <code className="text-gray-400">nodes.{edge.source}.*</code>.
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-500">
              Target sieht ausschließlich die gemappten Felder unter <code className="text-gray-400">incoming.*</code>.
            </p>
            <div className="space-y-1.5">
              {Object.entries(mapping).map(([targetKey, sourcePath]) => (
                <div key={targetKey} className="flex items-center gap-1">
                  <input
                    type="text"
                    value={targetKey}
                    onChange={(e) => updateMappingKey(targetKey, e.target.value)}
                    placeholder="target-key"
                    className="w-1/2 rounded bg-gray-900 border border-gray-800 px-2 py-1 font-mono text-xs text-gray-200 focus:border-cyan-700 focus:outline-none"
                  />
                  <span className="text-gray-600">←</span>
                  <input
                    type="text"
                    value={sourcePath}
                    onChange={(e) => updateMappingValue(targetKey, e.target.value)}
                    placeholder="source-path"
                    list={`src-out-${edge.id}`}
                    className="w-1/2 rounded bg-gray-900 border border-gray-800 px-2 py-1 font-mono text-xs text-gray-200 focus:border-cyan-700 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(targetKey)}
                    className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"
                    title="Zeile entfernen"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {sourceKeys.length > 0 && (
                <datalist id={`src-out-${edge.id}`}>
                  {sourceKeys.map((k) => <option key={k} value={k} />)}
                </datalist>
              )}
              <button
                type="button"
                onClick={addRow}
                className="mt-1 flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
              >
                <Plus size={12} /> Zeile
              </button>
            </div>
          </>
        )}
      </div>

      <button onClick={onDelete} className="self-start rounded bg-red-900/50 px-3 py-1 text-xs text-red-200 hover:bg-red-900">Edge löschen</button>
    </div>
  );
}
