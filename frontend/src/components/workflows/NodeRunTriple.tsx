import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowNodeRun } from '../../api/workflows';
import {
  isTruncatedSnapshot,
  readLines,
} from '../../lib/placeholder-view';
import { PlaceholderList } from './PlaceholderList';

interface Props {
  nodeRun?: WorkflowNodeRun;
  /** Text, solange kein NodeRun gewählt ist. */
  emptyHint?: string;
}

function isEmpty(data: Record<string, unknown> | undefined): boolean {
  return !data || Object.keys(data).length === 0;
}

/**
 * Bekommen / Eingesetzt / Ergebnis eines NodeRuns. Gemeinsame Ansicht für den
 * Lauf-Inspektor und das Debug-Panel. Secrets sind im NodeRun schon als
 * ••••(KEY) maskiert; hier wird nur angezeigt, nie entschlüsselt.
 */
export function NodeRunTriple({ nodeRun, emptyHint }: Props) {
  const { t } = useTranslation();
  if (!nodeRun) {
    return <div className="p-4 text-xs text-gray-500">{emptyHint ?? t('workflows.triple.empty')}</div>;
  }
  const traces = nodeRun.placeholders ?? [];
  const output = nodeRun.outputSnapshot;
  const lines = readLines(output);
  const truncated = isTruncatedSnapshot(output) || isTruncatedSnapshot(nodeRun.inputSnapshot) || isTruncatedSnapshot(nodeRun.resolvedConfig);

  return (
    <div className="@container"><div className="grid grid-cols-1 gap-3 p-3 @3xl:grid-cols-3">
      <Column title={t('workflows.triple.received')}>
        <JsonBlock data={nodeRun.inputSnapshot} emptyText={t('workflows.triple.receivedEmpty')} />
      </Column>

      <Column title={t('workflows.triple.applied')}>
        <JsonBlock data={nodeRun.resolvedConfig} emptyText={t('workflows.triple.appliedEmpty')} />
        <PlaceholderList traces={traces} />
      </Column>

      <Column title={t('workflows.triple.result')}>
        {nodeRun.dryRun && (
          <div className="mb-2 rounded-sm bg-violet-900/30 px-2 py-1 text-[11px] text-violet-200">{t('workflows.triple.dryRun')}</div>
        )}
        {truncated && (
          <div className="mb-2 rounded-sm bg-amber-900/30 px-2 py-1 text-[11px] text-amber-200">{t('workflows.triple.truncated')}</div>
        )}
        {nodeRun.error && (
          <div className="mb-2 rounded-sm bg-red-900/20 p-2 text-xs text-red-300">
            <div className="font-mono">{nodeRun.error.code}</div>
            <div>{nodeRun.error.message}</div>
          </div>
        )}
        {lines ? (
          <table className="w-full text-[11px]" data-testid="line-results">
            <thead className="text-gray-500">
              <tr>
                <th className="px-1 py-1 text-left">{t('workflows.triple.colLine')}</th>
                <th className="px-1 py-1 text-left">{t('workflows.triple.colCommand')}</th>
                <th className="px-1 py-1 text-left">{t('workflows.triple.colExit')}</th>
                <th className="px-1 py-1 text-left">{t('workflows.triple.colDuration')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => <LineRow key={l.line} line={l} />)}
            </tbody>
          </table>
        ) : (
          <JsonBlock data={output} emptyText={t('workflows.triple.resultEmpty')} />
        )}
      </Column>
    </div></div>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1 text-xs uppercase tracking-wide text-gray-400">{title}</h4>
      {children}
    </section>
  );
}

function JsonBlock({ data, emptyText }: { data: Record<string, unknown> | undefined; emptyText: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-sm bg-gray-950 p-2 text-xs text-gray-300">
      {isEmpty(data) ? emptyText : JSON.stringify(data, null, 2)}
    </pre>
  );
}

function LineRow({ line }: { line: NonNullable<ReturnType<typeof readLines>>[number] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasOutput = line.stdout !== '' || line.stderr !== '';
  const failed = line.exitCode !== 0 || line.aborted !== undefined;
  return (
    <>
      <tr
        className={`border-t border-gray-800 ${hasOutput ? 'cursor-pointer hover:bg-gray-800/50' : ''}`}
        onClick={hasOutput ? () => setOpen((o) => !o) : undefined}
      >
        <td className="px-1 py-1 text-gray-400">{hasOutput ? (open ? '▾ ' : '▸ ') : ''}{line.line}</td>
        <td className="px-1 py-1 font-mono break-all text-gray-200">{line.command}</td>
        <td className={`px-1 py-1 font-mono ${failed ? 'text-red-300' : 'text-green-300'}`}>
          {line.aborted ?? (line.exitCode ?? '—')}
        </td>
        <td className="px-1 py-1 text-gray-400">{line.durationMs !== null ? `${line.durationMs}ms` : '—'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="px-1 pb-2">
            {line.stdout !== '' && (
              <>
                <div className="text-[10px] uppercase text-gray-500">{t('workflows.triple.stdout')}</div>
                <pre className="max-h-40 overflow-auto rounded-sm bg-gray-950 p-2 text-gray-300">{line.stdout}</pre>
              </>
            )}
            {line.stderr !== '' && (
              <>
                <div className="text-[10px] uppercase text-gray-500">{t('workflows.triple.stderr')}</div>
                <pre className="max-h-40 overflow-auto rounded-sm bg-red-900/20 p-2 text-red-300">{line.stderr}</pre>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
