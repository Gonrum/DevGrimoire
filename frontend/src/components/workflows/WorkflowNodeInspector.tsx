import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Copy, ArrowRight, Plus, X } from 'lucide-react';
import { WorkflowNodeMetadata, WorkflowEdge as WfEdge } from '../../api/workflows';
import { isRecord } from '../../lib/narrow';
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
  const { t } = useTranslation();
  const { selectedNode, selectedEdge } = props;

  if (!selectedNode && !selectedEdge) {
    return (
      <div className="flex h-full items-center justify-center border-l border-gray-800 bg-gray-950 p-6 text-sm text-gray-500">
        {t('workflows.inspector.empty')}
      </div>
    );
  }

  if (selectedEdge) {
    const sourceNode = props.nodesById[selectedEdge.source];
    const sourceMeta = sourceNode ? props.catalog.find((c) => c.type === sourceNode.type) : undefined;
    // Nur die Schlüssel werden benutzt; die Werte behauptet hier niemand mehr.
    const sourceOutputs = sourceMeta?.outputs ?? {};
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
  const { t } = useTranslation();
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
            <button onClick={p.onDuplicateNode} title={t('workflows.node.duplicate')} className="rounded-sm p-1 text-gray-300 hover:bg-gray-800"><Copy size={14} /></button>
            <button onClick={p.onDeleteNode} title={t('common.delete')} className="rounded-sm p-1 text-gray-300 hover:bg-gray-800 hover:text-red-400"><Trash2 size={14} /></button>
          </div>
        </div>
        <div className="mt-1 text-sm text-gray-200">{meta?.label ?? node.type}</div>
        {meta?.description && <div className="mt-1 text-xs text-gray-500">{meta.description}</div>}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <section>
          <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">{t('workflows.inspector.configuration')}</h3>
          {meta ? (
            meta.configJsonSchema.type === 'object' ? (
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
                onChange={(v) => {
                  // `SchemaField` meldet `undefined`, wenn die letzte Zeile
                  // einer additionalProperties-Map gelöscht wird. Vorher ging
                  // dieses `undefined` als "Config" durch — hier wird daraus
                  // die leere Config, die es meint.
                  p.onChangeConfig(isRecord(v) ? v : {});
                }}
                templateOptions={templateOptions}
              />
            )
          ) : (
            <div className="text-xs text-amber-400">{t('workflows.inspector.unknownType')}</div>
          )}
        </section>

        {meta && Object.keys(meta.outputs).length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">{t('workflows.inspector.outputs')}</h3>
            <ul className="text-xs">
              {Object.entries(meta.outputs).map(([k, outType]) => (
                <li key={k} className="font-mono text-gray-400">• {k}: <span className="text-gray-500">{outType}</span></li>
              ))}
            </ul>
          </section>
        )}

        {meta && meta.branches.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">{t('workflows.inspector.branches')}</h3>
            <ul className="text-xs">
              {meta.branches.map((b) => (
                <li key={b} className="text-gray-400">○ {t('workflows.inspector.branchOutgoing', { branch: b, count: outgoingEdgeCountByBranch[b] ?? 0 })}</li>
              ))}
            </ul>
          </section>
        )}

        {p.outgoingEdges.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">{t('workflows.inspector.downstream')}</h3>
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
                      className="flex w-full items-center justify-between gap-2 rounded-sm border border-gray-800 bg-gray-900 px-2 py-1.5 text-left text-xs hover:border-cyan-700 hover:bg-gray-800"
                    >
                      <span className="flex items-center gap-1 text-gray-300">
                        <ArrowRight size={12} className="text-gray-500" />
                        <span className="font-mono">{targetLabel}</span>
                      </span>
                      <span className={mappingKeys.length > 0 ? 'text-cyan-300' : 'text-gray-500'}>
                        {mappingKeys.length > 0 ? t('workflows.inspector.mappedCount', { count: mappingKeys.length }) : t('workflows.inspector.passThroughShort')}
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
            <h3 className="mb-2 text-xs uppercase tracking-wide text-amber-400">⚠ {t('workflows.inspector.validation')}</h3>
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
  /** Nur `Object.keys` wird gelesen — die Werte sind ungeprüftes Katalog-JSON. */
  sourceOutputs: Record<string, unknown>;
  onChangeBranch: (b: 'success' | 'failure' | 'custom' | 'always') => void;
  onChangePayloadMapping: (mapping: Record<string, string> | undefined) => void;
  onDelete: () => void;
}

function EdgeInspector({ edge, sourceOutputs, onChangeBranch, onChangePayloadMapping, onDelete }: EdgeInspectorProps) {
  const { t } = useTranslation();
  const branches: Array<'success' | 'failure' | 'custom' | 'always'> = ['success', 'failure', 'custom', 'always'];
  const current = edge.branch ?? 'always';
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
      <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">{t('workflows.inspector.edge')}</h3>
      <div className="mb-3 text-xs text-gray-400 font-mono">{edge.source} → {edge.target}</div>
      <div className="mb-4">
        <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">{t('workflows.inspector.branch')}</label>
        <div className="flex flex-wrap gap-1">
          {branches.map((b) => (
            <button key={b} onClick={() => onChangeBranch(b)} className={`rounded-sm px-2 py-1 text-xs ${current === b ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>{b}</button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">{t('workflows.inspector.payloadMapping')}</label>
        <div className="mb-2 flex gap-1">
          <button
            type="button"
            onClick={() => onChangePayloadMapping(undefined)}
            className={`flex-1 rounded-sm px-2 py-1 text-xs ${!isMapped ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            {t('workflows.inspector.passThrough')}
          </button>
          <button
            type="button"
            onClick={() => { if (!isMapped) addRow(); }}
            className={`flex-1 rounded-sm px-2 py-1 text-xs ${isMapped ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            {t('workflows.inspector.mapFields')}
          </button>
        </div>
        {!isMapped ? (
          <p className="text-xs text-gray-500">
            {t('workflows.inspector.passThroughHint')} <code className="text-gray-400">nodes.{edge.source}.*</code>.
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-500">
              {t('workflows.inspector.mappedHint')} <code className="text-gray-400">incoming.*</code>.
            </p>
            <div className="space-y-1.5">
              {Object.entries(mapping).map(([targetKey, sourcePath]) => (
                <div key={targetKey} className="flex items-center gap-1">
                  <input
                    type="text"
                    value={targetKey}
                    onChange={(e) => updateMappingKey(targetKey, e.target.value)}
                    placeholder="target-key"
                    className="w-1/2 rounded-sm bg-gray-900 border border-gray-800 px-2 py-1 font-mono text-xs text-gray-200 focus:border-cyan-700 focus:outline-hidden"
                  />
                  <span className="text-gray-600">←</span>
                  <input
                    type="text"
                    value={sourcePath}
                    onChange={(e) => updateMappingValue(targetKey, e.target.value)}
                    placeholder="source-path"
                    list={`src-out-${edge.id}`}
                    className="w-1/2 rounded-sm bg-gray-900 border border-gray-800 px-2 py-1 font-mono text-xs text-gray-200 focus:border-cyan-700 focus:outline-hidden"
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(targetKey)}
                    className="rounded-sm p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"
                    title={t('workflows.inspector.removeRow')}
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
                className="mt-1 flex items-center gap-1 rounded-sm bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
              >
                <Plus size={12} /> {t('workflows.inspector.addRow')}
              </button>
            </div>
          </>
        )}
      </div>

      <button onClick={onDelete} className="self-start rounded-sm bg-red-900/50 px-3 py-1 text-xs text-red-200 hover:bg-red-900">{t('workflows.edge.delete')}</button>
    </div>
  );
}
