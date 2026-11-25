import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  MessageSquarePlus,
  PanelRightClose,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  type AgentRoleInfo,
  type ChatConfig,
  type ChatMessage,
  type Workspace,
  type WorkspaceAgentAllowEntry,
  type WorkspaceAgentMode,
  type WorkspaceAgentToolSet,
} from '../api/client';
import { AgentToolSetsField } from '../components/AgentToolSetsField';
import { MessageBubble, StreamingActivity } from '../components/ChatDock';
import Markdown from '../components/Markdown';
import { useToast } from '../components/Toast';
import Switch from '../components/ui/Switch';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { errorMessage, isRecord } from '../lib/narrow';
import { codeRefLabel, type ChatCodeRef } from './code-refs';
import { useIdeStore } from './ide-store';
import { AgentConfirmCard } from './AgentConfirmCard';
import { messageKey, useAgentChat, type AgentToolCall } from './useAgentChat';

const MODE_BUTTON = {
  on: 'bg-cyan-400/15 text-cyan-300',
  off: 'text-gray-400 hover:bg-gray-700 hover:text-gray-200',
} as const;

function parseJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** What a tool call works on, for the compact row: path, move, or command. */
function toolTarget(name: string, rawArgs: string): string {
  const args = parseJson(rawArgs);
  if (!args) return '';
  if (name === 'ws_exec') return str(args.command) ?? '';
  if (name === 'ws_move') return `${str(args.from) ?? '?'} → ${str(args.to) ?? '?'}`;
  if (name === 'ws_search') return str(args.query) ?? '';
  return str(args.path) ?? '';
}

interface ExecOutput {
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
}

function execOutput(result: string | undefined): ExecOutput | null {
  if (!result) return null;
  const r = parseJson(result);
  // Cut at the result limit, the JSON no longer parses: show the text as it is.
  if (!r) return { stdout: result, stderr: '', timedOut: false, truncated: true, aborted: false };
  return {
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : undefined,
    stdout: str(r.stdout) ?? '',
    stderr: str(r.stderr) ?? '',
    timedOut: r.timedOut === true,
    truncated: r.truncated === true,
    aborted: r.aborted === true,
  };
}

/** Compact tool call: state, name, target; the command output folds out. */
function AgentToolRow({ call }: { call: AgentToolCall }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pending = call.success === undefined;
  const failed = call.success === false;
  const target = toolTarget(call.name, call.arguments);
  const exec = call.name === 'ws_exec' ? execOutput(call.result) : null;
  const detail = exec !== null || (failed && !!call.summary) || (!!call.result && call.name !== 'ws_exec');

  return (
    <div className="rounded-sm border border-gray-700 bg-gray-900/60 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left disabled:cursor-default"
        disabled={!detail}
        onClick={() => setOpen((o) => !o)}
      >
        {pending ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-amber-400" />
        ) : failed ? (
          <X size={12} className="shrink-0 text-red-400" />
        ) : (
          <Check size={12} className="shrink-0 text-green-400" />
        )}
        <span className="shrink-0 font-mono text-gray-300">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-gray-500" title={target}>{target}</span>
        {exec?.exitCode !== undefined && (
          <span className={`shrink-0 font-mono ${exec.exitCode === 0 ? 'text-green-400' : 'text-red-400'}`}>
            {t('ide.agent.exitCode', { code: exec.exitCode })}
          </span>
        )}
        {detail && (open ? <ChevronDown size={12} className="shrink-0 text-gray-500" /> : <ChevronRight size={12} className="shrink-0 text-gray-500" />)}
      </button>
      {open && (
        <div className="space-y-1 border-t border-gray-700 p-1.5">
          {failed && call.summary && <p className="break-all text-red-300">{call.summary}</p>}
          {exec && (
            <>
              {(exec.timedOut || exec.aborted || exec.truncated) && (
                <p className="text-amber-300">
                  {[
                    exec.timedOut ? t('ide.agent.execTimedOut') : null,
                    exec.aborted ? t('ide.agent.execAborted') : null,
                    exec.truncated ? t('ide.agent.execTruncated') : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              )}
              {exec.stdout && (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-950 p-1.5 font-mono text-[11px] text-gray-200">{exec.stdout}</pre>
              )}
              {exec.stderr && (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-950 p-1.5 font-mono text-[11px] text-red-200">{exec.stderr}</pre>
              )}
              {!exec.stdout && !exec.stderr && <p className="text-gray-500">{t('ide.agent.execNoOutput')}</p>}
            </>
          )}
          {!exec && call.result && call.name !== 'ws_exec' && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-950 p-1.5 font-mono text-[11px] text-gray-400">
              {call.result.length > 2000 ? `${call.result.slice(0, 2000)}…` : call.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function CodeRefChips({ refs, onRemove }: { refs: readonly ChatCodeRef[]; onRemove?: (index: number) => void }) {
  const { t } = useTranslation();
  if (refs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {refs.map((ref, i) => (
        <span
          key={`${i}:${ref.kind}:${ref.path}:${ref.kind === 'selection' ? `${ref.startLine}-${ref.endLine}` : ''}`}
          title={ref.kind === 'selection' && ref.unsaved ? `${ref.path} (${t('ide.agent.attachUnsaved')})` : ref.path}
          className="inline-flex max-w-full items-center gap-1 rounded-sm border border-gray-700 bg-gray-800 px-1.5 py-0.5 font-mono text-[11px] text-cyan-300"
        >
          <span className="truncate">{codeRefLabel(ref)}</span>
          {ref.kind === 'selection' && ref.unsaved && <span className="shrink-0 text-amber-300">*</span>}
          {onRemove && (
            <button
              type="button"
              aria-label={t('ide.agent.attachRemove', { label: codeRefLabel(ref) })}
              className="shrink-0 text-gray-500 hover:text-red-300"
              onClick={() => onRemove(i)}
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function AgentMessage({ message }: { message: ChatMessage }) {
  if (message.role === 'system') {
    return <p className="px-1 text-xs italic text-gray-500">{message.content}</p>;
  }
  const calls = message.toolCalls ?? [];
  return (
    <div className="space-y-1">
      {calls.length > 0 && (
        <div className="space-y-1">
          {calls.map((tc) => (
            <AgentToolRow
              key={tc.id}
              call={{ id: tc.id, name: tc.name, arguments: tc.arguments, success: tc.success, summary: tc.error, result: tc.result }}
            />
          ))}
        </div>
      )}
      {(message.role === 'user' || message.content.trim() !== '') && (
        <MessageBubble
          message={{ ...message, toolCalls: undefined }}
          extra={message.role === 'user' && message.codeRefs?.length ? <CodeRefChips refs={message.codeRefs} /> : undefined}
        />
      )}
    </div>
  );
}

function AllowEntryLabel({ entry }: { entry: WorkspaceAgentAllowEntry }) {
  const { t } = useTranslation();
  if (entry.kind === 'command') {
    return <span className="break-all font-mono text-gray-200">{entry.value}</span>;
  }
  const key = entry.kind === 'files.write'
    ? 'ide.agent.kindFilesWrite'
    : entry.kind === 'files.structure'
      ? 'ide.agent.kindFilesStructure'
      : 'ide.agent.kindFilesDelete';
  return <span className="text-gray-200">{t(key)}</span>;
}

function AllowList({
  workspace,
  onChanged,
}: {
  workspace: Workspace;
  onChanged: (ws: Workspace | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const { showError } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const entries = workspace.agentAllow ?? [];
  const isSsh = workspace.location === 'ssh';

  const remove = (entry: WorkspaceAgentAllowEntry): void => {
    setBusy(true);
    api.workspaces.removeAgentAllow(workspace._id, entry._id).then(
      () => {
        setBusy(false);
        onChanged(null);
      },
      (err: unknown) => {
        setBusy(false);
        showError(errorMessage(err));
      },
    );
  };

  const setCredentials = (next: boolean): void => {
    setBusy(true);
    api.workspaces.update(workspace._id, { agentCredentials: next }).then(
      (ws) => {
        setBusy(false);
        onChanged(ws);
      },
      (err: unknown) => {
        setBusy(false);
        showError(errorMessage(err));
      },
    );
  };

  return (
    <div className="border-b border-gray-700 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-gray-300 hover:bg-gray-800"
        aria-expanded={open}
        onClick={() => {
          if (!open) onChanged(null);
          setOpen((o) => !o);
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{t('ide.agent.allowed', { count: entries.length })}</span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2">
          <p className="flex items-start gap-1 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {t('ide.agent.allowEscalationHint')}
          </p>
          {entries.length === 0 && <p className="text-gray-500">{t('ide.agent.allowedEmpty')}</p>}
          {entries.length > 0 && (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <li key={entry._id} className="flex items-start gap-1.5 rounded-sm bg-gray-800/60 px-1.5 py-1">
                  <div className="min-w-0 flex-1">
                    <AllowEntryLabel entry={entry} />
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                      <span>{entry.kind === 'command' ? t('ide.agent.kindCommandExact') : t('ide.agent.kindFiles')}</span>
                      <span>{new Date(entry.createdAt).toLocaleDateString(i18n.language)}</span>
                      {entry.inactive && (
                        <span className="rounded-sm bg-gray-700 px-1 text-gray-300" title={t('ide.agent.inactiveHint')}>
                          {t('ide.agent.inactive')}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    title={t('ide.agent.removeAllow')}
                    aria-label={t('ide.agent.removeAllow')}
                    className="shrink-0 rounded-sm p-0.5 text-gray-500 hover:bg-gray-700 hover:text-red-300 disabled:opacity-50"
                    onClick={() => remove(entry)}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!isSsh && (
            <div className="space-y-1 border-t border-gray-700 pt-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-gray-300">{t('ide.agent.credentials')}</span>
                <Switch
                  checked={workspace.agentCredentials === true}
                  disabled={busy}
                  label={t('ide.agent.credentials')}
                  onChange={setCredentials}
                />
              </div>
              <p className="flex items-start gap-1 text-[11px] text-amber-300">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                {t('ide.agent.credentialsWarning')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** No stream event for this long while the model is asked: it is most likely reasoning. */
const THINKING_AFTER_MS = 10_000;

/**
 * True once `key` has stayed the same for `ms` (null = not waiting). The
 * backend sends nothing while a model reasons, so a long silence in the
 * thinking/responding phase is shown as "model is thinking".
 */
function useSilentFor(key: string | null, ms: number): boolean {
  const [silentKey, setSilentKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return undefined;
    const timer = window.setTimeout(() => setSilentKey(key), ms);
    return () => window.clearTimeout(timer);
  }, [key, ms]);
  return key !== null && silentKey === key;
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1 px-2 py-1 text-[11px] text-amber-300">
      <Info size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Agent sidebar of the IDE: a chat bound to this workspace, with confirm cards and the allow list. */
export function AgentPanel({ workspace: initial, onCollapse }: { workspace: Workspace; onCollapse?: () => void }) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [workspace, setWorkspace] = useState(initial);
  const [config, setConfig] = useState<ChatConfig | null>(null);
  const [roles, setRoles] = useState<AgentRoleInfo[]>([]);
  const [roleId, setRoleId] = useState('');
  const [browserMode, setBrowserMode] = useState(false);
  const [draft, setDraft] = useState('');
  const [modeBusy, setModeBusy] = useState(false);
  const [toolSetsBusy, setToolSetsBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submittingRef = useRef(false);
  const codeRefs = useIdeStore((s) => s.codeRefs);
  const codeRefFocusTick = useIdeStore((s) => s.codeRefFocusTick);
  const isSsh = workspace.location === 'ssh';
  const mode: WorkspaceAgentMode = workspace.agentMode === 'direct' ? 'direct' : 'confirm';
  // Missing on records from before tool sets existed: the backend treats that as both.
  const toolSets: WorkspaceAgentToolSet[] = workspace.agentToolSets ?? ['todos', 'knowledge'];

  const reloadWorkspace = useCallback((next: Workspace | null) => {
    if (next) {
      setWorkspace(next);
      return;
    }
    api.workspaces.get(initial._id).then(setWorkspace, () => undefined);
  }, [initial._id]);

  const chat = useAgentChat(
    { projectId: initial.projectId, workspaceId: initial._id },
    { onAllowListChanged: () => reloadWorkspace(null) },
  );

  useEffect(() => {
    let alive = true;
    api.chat.getConfig().then((c) => { if (alive) setConfig(c); }, () => undefined);
    api.agentRoles.list().then((r) => { if (alive) setRoles(r); }, () => undefined);
    api.profile.get().then((p) => { if (alive) setBrowserMode(p.llmConfig?.mode === 'browser'); }, () => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const noWsTools = useMemo(() => {
    if (!config) return false;
    if (config.toolsEnabled !== true) return true;
    const role = roles.find((r) => r.id === roleId);
    const allow = config.toolsAllowlist ?? [];
    const effective = role ? allow.filter((name) => role.allowedTools.includes(name)) : allow;
    return !effective.some((name) => name.startsWith('ws_'));
  }, [config, roles, roleId]);

  const messageCount = chat.messages.length;
  const streamedLength = chat.streaming?.content.length ?? 0;
  const streamedCalls = chat.streaming?.toolCalls.length ?? 0;
  const streamedResults = chat.streaming?.toolCalls.filter((tc) => tc.success !== undefined).length ?? 0;
  const phase = chat.streaming?.phase;
  // Waiting on the model (first answer, or the next round after a tool): any event resets the clock.
  const waitKey = chat.streaming && !chat.proposal && (phase === 'thinking' || phase === 'responding')
    ? `${phase}|${streamedLength}|${streamedCalls}|${streamedResults}`
    : null;
  const modelThinking = useSilentFor(waitKey, THINKING_AFTER_MS);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messageCount, streamedLength, streamedCalls, chat.proposal, chat.notes.length]);

  const setMode = (next: WorkspaceAgentMode): void => {
    if (next === mode || modeBusy) return;
    setModeBusy(true);
    api.workspaces.update(workspace._id, { agentMode: next }).then(
      (ws) => {
        setModeBusy(false);
        setWorkspace(ws);
      },
      (err: unknown) => {
        setModeBusy(false);
        showError(errorMessage(err));
      },
    );
  };

  const setToolSets = (next: WorkspaceAgentToolSet[]): void => {
    if (toolSetsBusy) return;
    setToolSetsBusy(true);
    api.workspaces.update(workspace._id, { agentToolSets: next }).then(
      (ws) => {
        setToolSetsBusy(false);
        setWorkspace(ws);
      },
      (err: unknown) => {
        setToolSetsBusy(false);
        showError(errorMessage(err));
      },
    );
  };

  useEffect(() => {
    if (codeRefFocusTick > 0) textareaRef.current?.focus();
  }, [codeRefFocusTick]);

  const submit = (): void => {
    const text = draft;
    const refs = codeRefs;
    if ((!text.trim() && refs.length === 0) || chat.busy || submittingRef.current) return;
    // Draft and sent refs are cleared as soon as the message is accepted (before streaming);
    // a rejected send leaves both untouched. The guard covers the session-creation await.
    submittingRef.current = true;
    void chat
      .send(text, roleId || undefined, refs, () => {
        setDraft((d) => (d === text ? '' : d));
        useIdeStore.getState().removeSentCodeRefs(refs);
      })
      .finally(() => {
        submittingRef.current = false;
      });
  };

  const disabled = config?.enabled === false;
  const noEndpoint = config !== null && config.endpoints.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex items-center gap-1.5 border-b border-gray-700 px-2 py-1.5">
        <Bot size={14} className="text-cyan-400" />
        <span className="flex-1 text-xs font-medium uppercase tracking-wide text-gray-400">{t('ide.agent.title')}</span>
        <button
          type="button"
          title={t('ide.agent.newConversation')}
          aria-label={t('ide.agent.newConversation')}
          disabled={chat.busy}
          className="rounded-sm p-1 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-40"
          onClick={chat.newConversation}
        >
          <MessageSquarePlus size={14} />
        </button>
        {onCollapse && (
          <button
            type="button"
            title={t('ide.agent.hide')}
            aria-label={t('ide.agent.hide')}
            className="rounded-sm p-1 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            onClick={onCollapse}
          >
            <PanelRightClose size={14} />
          </button>
        )}
      </div>

      <div className="space-y-1.5 border-b border-gray-700 px-2 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-gray-400">{t('ide.agent.mode')}</span>
          <div className="flex rounded-sm border border-gray-700" role="group" aria-label={t('ide.agent.mode')}>
            <button
              type="button"
              aria-pressed={mode === 'confirm'}
              disabled={modeBusy}
              className={`rounded-l-sm px-2 py-0.5 ${mode === 'confirm' ? MODE_BUTTON.on : MODE_BUTTON.off}`}
              onClick={() => setMode('confirm')}
            >
              {t('ide.agent.modeConfirm')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'direct'}
              disabled={modeBusy}
              className={`rounded-r-sm px-2 py-0.5 ${mode === 'direct' ? MODE_BUTTON.on : MODE_BUTTON.off}`}
              onClick={() => setMode('direct')}
            >
              {t('ide.agent.modeDirect')}
            </button>
          </div>
        </div>
        {isSsh && mode === 'direct' && (
          <p className="flex items-start gap-1 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {t('ide.agent.sshDirectWarning')}
          </p>
        )}
        <AgentToolSetsField compact value={toolSets} disabled={toolSetsBusy} onChange={setToolSets} />
        {roles.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-gray-400">{t('ide.agent.role')}</span>
            <select
              className="min-w-0 flex-1 rounded-sm border border-gray-700 bg-gray-800 px-1 py-0.5 text-gray-200 outline-none focus:border-cyan-400"
              value={roleId}
              disabled={chat.busy}
              onChange={(e) => setRoleId(e.target.value)}
            >
              <option value="">{t('ide.agent.roleNone')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id} title={r.description}>{r.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <AllowList workspace={workspace} onChanged={reloadWorkspace} />

      {disabled && <Hint>{t('ide.agent.chatDisabled')}</Hint>}
      {!disabled && noEndpoint && <Hint>{t('ide.agent.noEndpoint')}</Hint>}
      {!disabled && noWsTools && <Hint>{t('ide.agent.noWsTools')}</Hint>}
      {browserMode && <Hint>{t('ide.agent.browserModeHint')}</Hint>}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {chat.loading && <LoadingText text={t('ide.loading')} />}
        {!chat.loading && messageCount === 0 && !chat.streaming && (
          <p className="text-xs text-gray-500">{t('ide.agent.empty')}</p>
        )}
        {chat.messages.map((m) => (
          <AgentMessage key={messageKey(m)} message={m} />
        ))}
        {chat.streaming && (
          <div className="space-y-1">
            {chat.streaming.toolCalls.map((tc) => (
              <AgentToolRow key={tc.id} call={tc} />
            ))}
            {chat.streaming.content && (
              <div className="rounded-lg border border-gray-700 bg-gray-800/60 p-3 text-sm text-gray-200">
                <Markdown>{chat.streaming.content}</Markdown>
              </div>
            )}
            {!chat.proposal && (
              <StreamingActivity
                phase={chat.streaming.phase}
                activeToolName={chat.streaming.activeToolName}
                label={modelThinking ? t('ide.agent.modelThinking') : undefined}
              />
            )}
          </div>
        )}
        {chat.proposal && (
          <AgentConfirmCard
            key={chat.proposal.callId}
            proposal={chat.proposal}
            onDecide={(approved, alwaysAllow) => void chat.decide(approved, alwaysAllow)}
          />
        )}
        {chat.notes.map((note, i) => (
          <p key={i} className="px-1 text-xs italic text-amber-300">{note}</p>
        ))}
        {chat.error && (
          <div className="flex items-start gap-1 rounded-sm border border-red-800/60 bg-red-900/20 px-2 py-1 text-xs text-red-300">
            <span className="min-w-0 flex-1 break-words">{chat.error}</span>
            <button type="button" aria-label={t('ide.close')} className="shrink-0 text-red-400 hover:text-red-200" onClick={chat.clearError}>
              <X size={12} />
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-gray-700 p-2">
        {codeRefs.length > 0 && (
          <div className="mb-1.5">
            <CodeRefChips refs={codeRefs} onRemove={(i) => useIdeStore.getState().removeCodeRef(i)} />
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={textareaRef}
            className="max-h-40 min-h-[2.5rem] min-w-0 flex-1 resize-y rounded-sm border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-200 outline-none focus:border-cyan-400"
            rows={2}
            value={draft}
            placeholder={t('ide.agent.placeholder')}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {chat.busy ? (
            <button
              type="button"
              title={t('ide.agent.stop')}
              aria-label={t('ide.agent.stop')}
              className="rounded-sm bg-red-500/15 p-2 text-red-300 hover:bg-red-500/25"
              onClick={chat.stop}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              type="button"
              title={t('ide.agent.send')}
              aria-label={t('ide.agent.send')}
              disabled={disabled || (!draft.trim() && codeRefs.length === 0)}
              className="rounded-sm bg-cyan-400/15 p-2 text-cyan-300 hover:bg-cyan-400/25 disabled:opacity-40"
              onClick={submit}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
