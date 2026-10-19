import { createElement, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RotateCcw, X, Loader2 } from 'lucide-react';
import { workflowsApi, NodeTestResult, WorkflowNodeMetadata } from '../../api/workflows';
import { errorMessage, isRecord, isUnknownArray } from '../../lib/narrow';
import { NodeConfigForm } from './NodeConfigForm';
import { nodeCategoryStyles } from './nodeCategoryStyles';
import { getNodeIcon } from './nodeTypeIconMap';
import { buildTemplateOptions, SelectedNode } from './nodeConfig';

interface Props {
  workflowId: string;
  node: SelectedNode;
  position: { x: number; y: number };
  meta: WorkflowNodeMetadata;
  catalog: WorkflowNodeMetadata[];
  upstreamNodes: SelectedNode[];
  localIssues: string[];
  onChangeConfig: (config: Record<string, unknown>) => void;
  onClose: () => void;
}

const EMPTY_CONTEXT = { input: {}, nodes: {} };

type InputSource =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'lastRun'; at: string };

/**
 * n8n-artiges Bearbeiten eines Nodes: links der Kontext, den der Node sieht
 * (vorbefüllt aus dem letzten Lauf), in der Mitte die Parameter, rechts der
 * Testlauf. Config-Änderungen gehen sofort in den Editor-State — und damit in
 * dessen Auto-Save; das Modal hält keine eigene Kopie.
 */
export function WorkflowNodeEditModal(p: Props) {
  const { t } = useTranslation();
  const style = nodeCategoryStyles[p.meta.category];

  const [inputText, setInputText] = useState(() => JSON.stringify(EMPTY_CONTEXT, null, 2));
  const [inputSource, setInputSource] = useState<InputSource>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<NodeTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const { onClose } = p;
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Vorbefüllung: Kontext des jüngsten Laufs, der schon Node-Ausgaben hat.
  useEffect(() => {
    let cancelled = false;
    workflowsApi.listRuns({ definitionId: p.workflowId, limit: 10 }).then((runs) => {
      if (cancelled) return;
      const run = runs.find((r) => isRecord(r.context?.nodes) && Object.keys(r.context.nodes).length > 0);
      if (!run?.context) {
        setInputText(JSON.stringify(EMPTY_CONTEXT, null, 2));
        setInputSource({ kind: 'empty' });
        return;
      }
      setInputText(JSON.stringify({ input: run.context.input ?? {}, nodes: run.context.nodes ?? {} }, null, 2));
      setInputSource({ kind: 'lastRun', at: run.startedAt ?? run.createdAt });
    }).catch(() => {
      if (cancelled) return;
      setInputSource({ kind: 'empty' });
    });
    return () => { cancelled = true; };
  }, [p.workflowId, reloadKey]);

  const parsedInput = useMemo((): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } => {
    try {
      const value: unknown = JSON.parse(inputText);
      if (!isRecord(value)) return { ok: false, error: t('workflows.nodeModal.inputNotObject') };
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }, [inputText, t]);

  const templateOptions = useMemo(
    () => buildTemplateOptions(p.catalog, p.upstreamNodes),
    [p.catalog, p.upstreamNodes],
  );

  const runTest = async () => {
    if (!parsedInput.ok) return;
    setTesting(true);
    setTestError(null);
    try {
      const ctx = parsedInput.value;
      const res = await workflowsApi.testNode({
        workflowId: p.workflowId,
        node: {
          id: p.node.id,
          type: p.node.type,
          position: p.position,
          config: p.node.config,
          secretRefs: p.node.secretRefs ?? [],
        },
        input: isRecord(ctx.input) ? ctx.input : {},
        runContext: ctx,
      });
      setResult(res);
    } catch (err) {
      setResult(null);
      setTestError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={p.meta.label}
        className="flex h-[88vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-950 shadow-2xl"
      >
        <header className={`flex items-center justify-between gap-3 border-b border-gray-800 px-4 py-3 ${style.headerBg}`}>
          <div className="flex min-w-0 items-center gap-2">
            {createElement(getNodeIcon(p.node.type), { size: 16, className: 'text-gray-300' })}
            <span className="truncate text-sm font-semibold text-gray-100">{p.meta.label}</span>
            <span className="font-mono text-xs text-gray-400">{p.node.id}</span>
            <span className="rounded-sm bg-gray-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-400">{p.node.type}</span>
          </div>
          <button type="button" onClick={onClose} title={t('common.close')} className="rounded-sm p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200">
            <X size={16} />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-3 lg:overflow-hidden">
          {/* Eingabe */}
          <section className="flex min-h-0 flex-col border-b border-gray-800 p-4 lg:border-b-0 lg:border-r">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-wide text-gray-500">{t('workflows.nodeModal.input')}</h3>
              <button
                type="button"
                onClick={() => { setInputSource({ kind: 'loading' }); setReloadKey((k) => k + 1); }}
                title={t('workflows.nodeModal.reloadInput')}
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              >
                <RotateCcw size={11} /> {t('workflows.nodeModal.reloadInput')}
              </button>
            </div>
            <p className="mb-2 text-xs text-gray-500">
              {inputSource.kind === 'loading' && t('common.loading')}
              {inputSource.kind === 'empty' && t('workflows.nodeModal.inputEmpty')}
              {inputSource.kind === 'lastRun' && t('workflows.nodeModal.inputFromRun', { at: new Date(inputSource.at).toLocaleString() })}
            </p>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              spellCheck={false}
              className="min-h-[240px] flex-1 resize-none rounded-sm border border-gray-800 bg-gray-900 p-2 font-mono text-xs text-gray-200 focus:border-cyan-700 focus:outline-hidden"
            />
            {!parsedInput.ok && <p className="mt-1 text-xs text-red-400">{t('workflows.nodeModal.inputInvalid', { error: parsedInput.error })}</p>}
            <p className="mt-2 text-[11px] text-gray-600">{t('workflows.nodeModal.inputHint')}</p>
          </section>

          {/* Parameter */}
          <section className="flex min-h-0 flex-col border-b border-gray-800 lg:border-b-0 lg:border-r">
            <div className="p-4 pb-2">
              <h3 className="text-xs uppercase tracking-wide text-gray-500">{t('workflows.nodeModal.parameters')}</h3>
              {p.meta.description && <p className="mt-1 text-xs text-gray-500">{p.meta.description}</p>}
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
              <NodeConfigForm
                meta={p.meta}
                config={p.node.config}
                onChange={p.onChangeConfig}
                templateOptions={templateOptions}
              />
              {p.localIssues.length > 0 && (
                <ul className="text-xs text-amber-300">
                  {p.localIssues.map((iss) => <li key={iss}>⚠ {iss}</li>)}
                </ul>
              )}
            </div>
          </section>

          {/* Ausgabe */}
          <section className="flex min-h-0 flex-col p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-wide text-gray-500">{t('workflows.nodeModal.output')}</h3>
              <button
                type="button"
                onClick={() => { void runTest(); }}
                disabled={testing || !parsedInput.ok}
                className="inline-flex items-center gap-1 rounded-sm bg-cyan-600 px-3 py-1 text-xs text-white hover:bg-cyan-500 disabled:opacity-50"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                {t('workflows.nodeModal.test')}
              </button>
            </div>
            {p.meta.category === 'agent' && (
              <p className="mb-2 text-[11px] text-gray-500">{t('workflows.nodeModal.agentDryRunHint')}</p>
            )}
            {p.meta.category === 'action' && (
              <p className="mb-2 text-[11px] text-gray-500">{t('workflows.nodeModal.actionValidationHint')}</p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {testError && <p className="text-xs text-red-400">{testError}</p>}
              {!result && !testError && !testing && (
                <p className="text-xs text-gray-600">{t('workflows.nodeModal.noResult')}</p>
              )}
              {result && <TestResultView result={result} />}
            </div>
          </section>
        </div>

        <footer className="flex items-center justify-between border-t border-gray-800 px-4 py-2">
          <span className="text-[11px] text-gray-500">{t('workflows.nodeModal.autoSaveHint')}</span>
          <button type="button" onClick={onClose} className="rounded-sm bg-gray-800 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700">
            {t('common.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function TestResultView({ result }: { result: NodeTestResult }) {
  const { t } = useTranslation();
  const modeLabel = result.mode ? t(`workflows.nodeModal.mode.${result.mode}`) : '—';
  const issues = isUnknownArray(result.issues) ? result.issues.filter((i): i is string => typeof i === 'string') : [];
  const failed = !result.ok;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-sm px-2 py-0.5 font-medium ${failed ? 'bg-red-900/50 text-red-200' : 'bg-green-900/40 text-green-200'}`}>
          {failed ? t('workflows.nodeModal.failed') : t('workflows.nodeModal.ok')}
        </span>
        <span className="rounded-sm bg-gray-800 px-2 py-0.5 text-gray-300">{modeLabel}</span>
        {result.status && <span className="font-mono text-gray-400">status: {result.status}</span>}
        {result.branch && <span className="font-mono text-gray-400">branch: {result.branch}</span>}
      </div>
      {result.reason && <p className="text-gray-400">{result.reason}</p>}
      {issues.length > 0 && (
        <ul className="space-y-0.5 text-amber-300">
          {issues.map((iss) => <li key={iss}>⚠ {iss}</li>)}
        </ul>
      )}
      <JsonBlock title={t('workflows.nodeModal.outputData')} value={result.outputPreview} />
      <JsonBlock title={t('workflows.nodeModal.error')} value={result.errorPreview} tone="error" />
      <JsonBlock title={t('workflows.nodeModal.waitingFor')} value={result.waitingForPreview} />
      <JsonBlock title={t('workflows.nodeModal.logs')} value={result.logPreview} />
    </div>
  );
}

function JsonBlock({ title, value, tone }: { title: string; value: unknown; tone?: 'error' }) {
  if (value === undefined || value === null) return null;
  if (isUnknownArray(value) && value.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">{title}</h4>
      <pre className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-gray-800 bg-gray-900 p-2 font-mono text-[11px] ${tone === 'error' ? 'text-red-300' : 'text-gray-200'}`}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
