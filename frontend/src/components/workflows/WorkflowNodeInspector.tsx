import { useMemo } from 'react';
import { Trash2, Copy } from 'lucide-react';
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
  localIssues: string[];
  onChangeConfig: (config: Record<string, unknown>) => void;
  onRenameNode: (oldId: string, newId: string) => void;
  onChangeNodeType: (newType: string) => void;
  onDeleteNode: () => void;
  onDuplicateNode: () => void;
  onChangeEdgeBranch: (branch: 'success' | 'failure' | 'custom' | 'always') => void;
  onDeleteEdge: () => void;
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
    return <EdgeInspector edge={selectedEdge} onChangeBranch={props.onChangeEdgeBranch} onDelete={props.onDeleteEdge} />;
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

function EdgeInspector({ edge, onChangeBranch, onDelete }: { edge: WfEdge; onChangeBranch: (b: 'success' | 'failure' | 'custom' | 'always') => void; onDelete: () => void }) {
  const branches: Array<'success' | 'failure' | 'custom' | 'always'> = ['success', 'failure', 'custom', 'always'];
  const current = (edge.branch as 'success' | 'failure' | 'custom' | 'always') ?? 'always';
  return (
    <div className="flex h-full flex-col border-l border-gray-800 bg-gray-950 p-4">
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
      <button onClick={onDelete} className="self-start rounded bg-red-900/50 px-3 py-1 text-xs text-red-200 hover:bg-red-900">Edge löschen</button>
    </div>
  );
}
