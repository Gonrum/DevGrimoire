import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Workspace } from '../api/client';
import Button from './ui/Button';

const HISTORY_KEY_PREFIX = 'devgrimoire_terminal_history:';
const HISTORY_MAX = 100;
const OUTPUT_KEEP_LINES = 2000;

interface OutputLine {
  id: number;
  kind: 'stdout' | 'stderr' | 'cmd' | 'meta' | 'error';
  text: string;
}

function loadHistory(workspaceId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY_PREFIX + workspaceId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === 'string');
  } catch {
    // ignore
  }
  return [];
}

function saveHistory(workspaceId: string, history: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      HISTORY_KEY_PREFIX + workspaceId,
      JSON.stringify(history.slice(-HISTORY_MAX)),
    );
  } catch {
    // quota exceeded — ignore, terminal still works
  }
}

interface Props {
  workspace: Workspace;
  onClose: () => void;
}

export default function WorkspaceTerminal({ workspace, onClose }: Props) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<string[]>(() => loadHistory(workspace._id));
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [draftBackup, setDraftBackup] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState<string>(workspace.path.replace(/\/$/, ''));
  const lineSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const outputEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const appendLine = useCallback((kind: OutputLine['kind'], text: string) => {
    setOutput((prev) => {
      const next = [...prev, { id: ++lineSeqRef.current, kind, text }];
      return next.length > OUTPUT_KEEP_LINES ? next.slice(-OUTPUT_KEEP_LINES) : next;
    });
  }, []);

  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ block: 'end' });
  }, [output]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const runCommand = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed || running) return;
      const next = [...history.filter((h) => h !== trimmed), trimmed];
      setHistory(next);
      saveHistory(workspace._id, next);
      setHistoryCursor(null);
      setDraftBackup('');
      setDraft('');
      appendLine('cmd', `$ ${trimmed}`);
      setRunning(true);
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        await api.workspaces.execStream(
          workspace._id,
          trimmed,
          (event) => {
            switch (event.type) {
              case 'stdout':
                appendLine('stdout', event.line);
                break;
              case 'stderr':
                appendLine('stderr', event.line);
                break;
              case 'truncated':
                appendLine('meta', `… (${event.stream} truncated at 1MB cap)`);
                break;
              case 'error':
                appendLine('error', event.message);
                break;
              case 'done': {
                const reason = event.timedOut
                  ? `timed out after ${event.durationMs}ms`
                  : event.killReason === 'abort'
                    ? `aborted (${event.durationMs}ms)`
                    : `exit ${event.exitCode} (${event.durationMs}ms)`;
                appendLine('meta', `▸ ${reason}`);
                break;
              }
              case 'cwd':
                setCwd(event.cwd);
                break;
            }
          },
          abort.signal,
        );
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          appendLine('meta', '▸ aborted');
        } else {
          appendLine('error', (err as Error).message);
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
        inputRef.current?.focus();
      }
    },
    [appendLine, history, running, workspace._id],
  );

  const cancelRunning = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runCommand(draft);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (history.length === 0) return;
        if (historyCursor === null) {
          setDraftBackup(draft);
          const cursor = history.length - 1;
          setHistoryCursor(cursor);
          setDraft(history[cursor]);
          return;
        }
        const cursor = Math.max(0, historyCursor - 1);
        setHistoryCursor(cursor);
        setDraft(history[cursor]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyCursor === null) return;
        const cursor = historyCursor + 1;
        if (cursor >= history.length) {
          setHistoryCursor(null);
          setDraft(draftBackup);
        } else {
          setHistoryCursor(cursor);
          setDraft(history[cursor]);
        }
      } else if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setOutput([]);
      } else if (e.key === 'c' && e.ctrlKey && running) {
        e.preventDefault();
        cancelRunning();
      }
    },
    [cancelRunning, draft, draftBackup, history, historyCursor, runCommand, running],
  );

  const copyOutput = useCallback(async () => {
    const text = output.map((l) => l.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }, [output]);

  const lineClass = useMemo<Record<OutputLine['kind'], string>>(() => ({
    stdout: 'text-gray-200',
    stderr: 'text-red-400',
    cmd: 'text-cyan-300 font-semibold',
    meta: 'text-violet-300 italic',
    error: 'text-red-400 font-semibold',
  }), []);

  // Show /workspaces/<id> as ~ in the prompt and any sub-dir as ~/<rel>
  // so the user gets a familiar shell-style location indicator without
  // the noisy long mongodb id every line.
  const promptPath = useMemo(() => {
    const root = workspace.path.replace(/\/$/, '');
    if (cwd === root) return '~';
    if (cwd.startsWith(root + '/')) return '~/' + cwd.slice(root.length + 1);
    return cwd;
  }, [cwd, workspace.path]);

  return (
    <div className="flex flex-col h-[70vh] min-h-[420px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="text-xs">
          <span className="text-gray-500">{t('terminal.workspace')}: </span>
          <span className="font-mono text-gray-200">{workspace.name}</span>
          <span className="text-gray-600 mx-2">·</span>
          <span className="font-mono text-gray-500">{workspace.path}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyOutput}
            className="text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-200"
          >
            {t('terminal.copy')}
          </button>
          <button
            type="button"
            onClick={() => setOutput([])}
            className="text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-200"
          >
            {t('terminal.clear')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-black px-3 py-2 font-mono text-xs leading-relaxed">
        {output.length === 0 ? (
          <div className="text-gray-600">{t('terminal.placeholder')}</div>
        ) : (
          output.map((line) => (
            <div key={line.id} className={`whitespace-pre-wrap ${lineClass[line.kind]}`}>
              {line.text || ' '}
            </div>
          ))
        )}
        <div ref={outputEndRef} />
      </div>

      <div className="border-t border-gray-800 px-3 py-2 flex items-center gap-2 bg-gray-950">
        <span className="font-mono text-xs text-cyan-400 select-none truncate max-w-[40%]" title={cwd}>
          {promptPath} $
        </span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setHistoryCursor(null);
          }}
          onKeyDown={onKeyDown}
          disabled={running}
          spellCheck={false}
          autoComplete="off"
          placeholder={running ? t('terminal.running') : t('terminal.prompt')}
          className="flex-1 bg-transparent border-none text-gray-100 font-mono text-xs focus:outline-none disabled:opacity-50"
        />
        {running ? (
          <Button variant="danger" size="xs" onClick={cancelRunning}>
            {t('terminal.cancel')}
          </Button>
        ) : (
          <Button variant="secondary" size="xs" onClick={() => runCommand(draft)} disabled={!draft.trim()}>
            {t('terminal.run')}
          </Button>
        )}
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 ml-1">
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
