import './monaco-setup';
import { useEffect, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { Check, Expand, FileText, KeyRound, ShieldCheck, SquareTerminal, X } from 'lucide-react';
import type { AgentAllowSuggestion } from '../api/client';
import { IdeDialog } from './IdeDialog';
import { useIdeStore } from './ide-store';
import { languageFromPath } from './language';
import { DEVGRIMOIRE_THEME } from './monaco-theme';
import type { AgentProposal } from './useAgentChat';

const INLINE_DIFF_OPTIONS = {
  fontSize: 12,
  minimap: { enabled: false },
  automaticLayout: true,
  readOnly: true,
  originalEditable: false,
  renderSideBySide: false,
  scrollBeyondLastLine: false,
  lineNumbers: 'off',
  folding: false,
  renderOverviewRuler: false,
} as const;

const WIDE_DIFF_OPTIONS = {
  fontSize: 13,
  minimap: { enabled: false },
  automaticLayout: true,
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
} as const;

/**
 * Read-only diff of a proposed file change. Same model handling as the conflict diff
 * in EditorPane: the models outlive the widget and are disposed after it, otherwise
 * Monaco throws "TextModel got disposed before DiffEditorWidget model got reset".
 */
function ProposalDiff({ path, original, modified, wide }: { path: string; original: string; modified: string; wide: boolean }) {
  const diffEditor = useRef<monacoEditor.IStandaloneDiffEditor | null>(null);
  useEffect(
    () => () => {
      const models = diffEditor.current?.getModel();
      setTimeout(() => {
        models?.original.dispose();
        models?.modified.dispose();
      }, 0);
    },
    [],
  );
  return (
    <DiffEditor
      theme={DEVGRIMOIRE_THEME}
      language={languageFromPath(path)}
      original={original}
      modified={modified}
      options={wide ? WIDE_DIFF_OPTIONS : INLINE_DIFF_OPTIONS}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        diffEditor.current = editor;
      }}
    />
  );
}

function suggestionKey(s: AgentAllowSuggestion): string {
  return s.kind === 'command' ? `command:${s.value}` : s.kind;
}

function SuggestionLabel({ suggestion }: { suggestion: AgentAllowSuggestion }) {
  const { t } = useTranslation();
  switch (suggestion.kind) {
    case 'files.write':
      return <>{t('ide.agent.allowFilesWrite')}</>;
    case 'files.structure':
      return <>{t('ide.agent.allowFilesStructure')}</>;
    case 'files.delete':
      return <>{t('ide.agent.allowFilesDelete')}</>;
    case 'command':
      return <>{t('ide.agent.allowCommandExact')}</>;
  }
}

function PathsPreview({ proposal }: { proposal: AgentProposal }) {
  const { t } = useTranslation();
  const p = proposal.preview;
  if (!p) return null;
  if (proposal.name === 'ws_move') {
    return (
      <p className="break-all font-mono text-xs text-gray-200">
        {t('ide.agent.previewMove', { from: p.from ?? '?', to: p.to ?? '?' })}
      </p>
    );
  }
  const key = proposal.name === 'ws_delete' ? 'ide.agent.previewDelete' : 'ide.agent.previewMkdir';
  return <p className="break-all font-mono text-xs text-gray-200">{t(key, { path: p.path ?? '?' })}</p>;
}

function CommandPreview({ proposal }: { proposal: AgentProposal }) {
  const { t } = useTranslation();
  const p = proposal.preview;
  if (!p) return null;
  return (
    <div className="space-y-1">
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-950 p-2 font-mono text-xs text-gray-100">
        {p.command}
      </pre>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-gray-400">
        <dt>{t('ide.agent.previewCwd')}</dt>
        <dd className="break-all font-mono text-gray-300">{p.cwd ?? '.'}</dd>
        <dt>{t('ide.agent.previewTimeout')}</dt>
        <dd className="text-gray-300">{t('ide.agent.seconds', { count: p.timeoutSec ?? 60 })}</dd>
      </dl>
      {p.credentials && (
        <p className="flex items-start gap-1 text-[11px] text-amber-300">
          <KeyRound size={12} className="mt-0.5 shrink-0" />
          {t('ide.agent.previewCredentials')}
        </p>
      )}
    </div>
  );
}

function FilePreview({ proposal }: { proposal: AgentProposal }) {
  const { t } = useTranslation();
  const [wide, setWide] = useState(false);
  const p = proposal.preview;
  if (!p?.path) return null;
  const path = p.path;
  const original = p.before ?? '';
  const modified = p.after ?? '';
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-xs">
        <FileText size={12} className="shrink-0 text-gray-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-gray-200" title={path}>{path}</span>
        {p.before === null && <span className="shrink-0 text-[11px] text-emerald-300">{t('ide.agent.newFile')}</span>}
        {p.before !== null && (
          <button
            type="button"
            className="shrink-0 rounded-sm px-1 text-[11px] text-cyan-400 hover:bg-gray-700"
            onClick={() => void useIdeStore.getState().openFile(path).catch(() => undefined)}
          >
            {t('ide.agent.openInEditor')}
          </button>
        )}
        <button
          type="button"
          title={t('ide.agent.enlargeDiff')}
          aria-label={t('ide.agent.enlargeDiff')}
          className="shrink-0 rounded-sm p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          onClick={() => setWide(true)}
        >
          <Expand size={12} />
        </button>
      </div>
      <div className="h-64 overflow-hidden rounded-sm border border-gray-700">
        <ProposalDiff path={path} original={original} modified={modified} wide={false} />
      </div>
      {wide && (
        <IdeDialog title={t('ide.agent.diffTitle', { path })} size="fill" onClose={() => setWide(false)}>
          <ProposalDiff path={path} original={original} modified={modified} wide />
        </IdeDialog>
      )}
    </div>
  );
}

/** Confirm card for one paused writing call: preview, accept/reject, optional "always allow". */
export function AgentConfirmCard({
  proposal,
  onDecide,
}: {
  proposal: AgentProposal;
  onDecide: (approved: boolean, alwaysAllow?: AgentAllowSuggestion) => void;
}) {
  const { t } = useTranslation();
  // Only what the server offered can be chosen; '' = just this once.
  const [allowKey, setAllowKey] = useState('');
  const kind = proposal.preview?.kind;
  const chosen = proposal.allowSuggestions.find((s) => suggestionKey(s) === allowKey);

  let rawArgs = '';
  if (!proposal.preview) {
    try {
      rawArgs = JSON.stringify(proposal.args, null, 2);
    } catch {
      rawArgs = '';
    }
  }

  return (
    <div className="space-y-2 rounded-sm border border-amber-700/50 bg-amber-950/20 p-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
        {kind === 'command' ? <SquareTerminal size={14} /> : <ShieldCheck size={14} />}
        <span>{t('ide.agent.confirmTitle')}</span>
        <span className="ml-auto font-mono text-[11px] text-gray-400">{proposal.name}</span>
      </div>
      {kind === 'file' && <FilePreview proposal={proposal} />}
      {kind === 'paths' && <PathsPreview proposal={proposal} />}
      {kind === 'command' && <CommandPreview proposal={proposal} />}
      {!proposal.preview && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-950 p-2 font-mono text-[11px] text-gray-300">
          {rawArgs}
        </pre>
      )}
      {proposal.allowSuggestions.length > 0 && (
        <fieldset className="space-y-0.5 text-xs text-gray-300">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`allow-${proposal.callId}`} checked={allowKey === ''} onChange={() => setAllowKey('')} />
            {t('ide.agent.allowOnce')}
          </label>
          {proposal.allowSuggestions.map((s) => (
            <label key={suggestionKey(s)} className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`allow-${proposal.callId}`}
                checked={allowKey === suggestionKey(s)}
                onChange={() => setAllowKey(suggestionKey(s))}
              />
              <SuggestionLabel suggestion={s} />
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm bg-cyan-400/15 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-400/25"
          onClick={() => onDecide(true, chosen)}
        >
          <Check size={12} />
          {kind === 'command' ? t('ide.agent.run') : t('ide.agent.accept')}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
          onClick={() => onDecide(false)}
        >
          <X size={12} />
          {t('ide.agent.reject')}
        </button>
      </div>
    </div>
  );
}
