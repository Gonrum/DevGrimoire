import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Files, Search, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Workspace } from '../api/client';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/narrow';
import { FileTree } from './FileTree';
import { useIdeStore, type SidePanel } from './ide-store';
import { SearchPanel } from './SearchPanel';
import { TerminalPanel } from './TerminalPanel';
import { useDivider } from './useIdeDividers';
import { useWorkspaceStatus } from './useWorkspaceStatus';

// Monaco lives in its own chunk: the header and the file tree show up before it has loaded.
const EditorPane = lazy(() => import('./EditorPane').then((m) => ({ default: m.EditorPane })));

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; workspace: Workspace }
  | { kind: 'notFound' }
  | { kind: 'forbidden' }
  | { kind: 'inactive'; workspace: Workspace }
  | { kind: 'error'; message: string };

const getSidebarWidth = (): number => useIdeStore.getState().sidebarWidth;
const getTerminalHeight = (): number => useIdeStore.getState().terminalHeight;

function RailButton({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`flex h-9 w-9 items-center justify-center rounded-sm ${
        pressed ? 'bg-cyan-400/15 text-cyan-400' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FullPageMessage({ title, text, backTo, backLabel }: { title: string; text: string; backTo?: string; backLabel?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-gray-200 mb-2">{title}</h1>
        <p className="text-sm text-gray-400 mb-4">{text}</p>
        {backTo && backLabel && (
          <Link to={backTo} className="text-sm text-cyan-400 hover:text-cyan-300">{backLabel}</Link>
        )}
      </div>
    </div>
  );
}

export default function IdePage() {
  const { t } = useTranslation();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const setWorkspace = useIdeStore((s) => s.setWorkspace);

  useEffect(() => {
    if (workspaceId) setWorkspace(workspaceId);
  }, [workspaceId, setWorkspace]);

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    api.workspaces.get(workspaceId).then(
      (workspace) => {
        if (!alive) return;
        setState(workspace.status === 'active' ? { kind: 'ready', workspace } : { kind: 'inactive', workspace });
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) setState({ kind: 'notFound' });
        else if (err instanceof ApiError && err.status === 403) setState({ kind: 'forbidden' });
        else setState({ kind: 'error', message: err instanceof Error ? err.message : t('ide.loadError') });
      },
    );
    return () => { alive = false; };
  }, [workspaceId, t]);

  const title = state.kind === 'ready' || state.kind === 'inactive' ? state.workspace.name : null;
  useEffect(() => {
    if (title) document.title = `${title} — IDE`;
  }, [title]);

  if (!workspaceId || state.kind === 'notFound') {
    return <FullPageMessage title={t('ide.notFoundTitle')} text={t('ide.notFoundText')} />;
  }
  if (state.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <LoadingText text={t('ide.loading')} />
      </div>
    );
  }
  if (state.kind === 'forbidden') {
    return <FullPageMessage title={t('ide.forbiddenTitle')} text={t('ide.forbiddenText')} />;
  }
  if (state.kind === 'error') {
    return <FullPageMessage title={t('ide.loadError')} text={state.message} />;
  }
  if (state.kind === 'inactive') {
    return (
      <FullPageMessage
        title={t('ide.inactiveTitle')}
        text={t('ide.inactiveText', { status: state.workspace.status })}
        backTo={`/projects/${state.workspace.projectId}`}
        backLabel={t('ide.backToProject')}
      />
    );
  }

  return <Workbench workspaceId={workspaceId} workspace={state.workspace} />;
}

function Workbench({ workspaceId, workspace }: { workspaceId: string; workspace: Workspace }) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const openFile = useIdeStore((s) => s.openFile);
  const activePath = useIdeStore((s) => s.activePath);
  const sidebarWidth = useIdeStore((s) => s.sidebarWidth);
  const setSidebarWidth = useIdeStore((s) => s.setSidebarWidth);
  const terminalHeight = useIdeStore((s) => s.terminalHeight);
  const setTerminalHeight = useIdeStore((s) => s.setTerminalHeight);
  const terminalOpen = useIdeStore((s) => s.terminalOpen);
  const setTerminalOpen = useIdeStore((s) => s.setTerminalOpen);
  const panel = useIdeStore((s) => s.panel);
  const setPanel = useIdeStore((s) => s.setPanel);
  const sidebarDivider = useDivider('x', getSidebarWidth, setSidebarWidth);
  const terminalDivider = useDivider('y', getTerminalHeight, setTerminalHeight, true);
  const { branch, marks } = useWorkspaceStatus(workspaceId);

  // Ctrl/Cmd+` toggles the terminal from anywhere on the page, including from inside the terminal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.code !== 'Backquote' && event.key !== '`') return;
      event.preventDefault();
      const { terminalOpen: open, setTerminalOpen: setOpen } = useIdeStore.getState();
      setOpen(!open);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-200">
      <header className="flex items-center gap-3 px-3 h-10 shrink-0 bg-gray-800 border-b border-gray-700 text-sm">
        <Link to={`/projects/${workspace.projectId}`} className="text-cyan-400 hover:text-cyan-300">
          ← {t('ide.backToProject')}
        </Link>
        <span className="font-medium truncate">{workspace.name}</span>
        {branch && <span className="text-gray-500 text-xs font-mono truncate">{branch}</span>}
      </header>
      <div className="flex flex-1 min-h-0">
        <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-gray-700 bg-gray-800 py-1">
          {(['files', 'search'] as const satisfies readonly SidePanel[]).map((id) => (
            <RailButton key={id} label={t(id === 'files' ? 'ide.files' : 'ide.search')} pressed={panel === id} onClick={() => setPanel(id)}>
              {id === 'files' ? <Files size={18} /> : <Search size={18} />}
            </RailButton>
          ))}
          <div className="flex-1" />
          <RailButton label={t('ide.terminal')} pressed={terminalOpen} onClick={() => setTerminalOpen(!terminalOpen)}>
            <SquareTerminal size={18} />
          </RailButton>
        </nav>
        <aside
          className="shrink-0 bg-gray-900 min-h-0"
          style={{ width: sidebarWidth }}
        >
          <div className={panel === 'files' ? 'h-full' : 'hidden'}>
            <FileTree
              key={workspaceId}
              workspaceId={workspaceId}
              activePath={activePath}
              marks={marks}
              onOpenFile={(path, size) => {
                openFile(path, size).catch((err: unknown) => showError(errorMessage(err)));
              }}
            />
          </div>
          {/* Stays mounted while hidden so the last results survive a switch to the file tree. */}
          <div className={panel === 'search' ? 'h-full' : 'hidden'}>
            <SearchPanel key={workspaceId} workspaceId={workspaceId} />
          </div>
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          className="w-1 shrink-0 cursor-col-resize touch-none bg-gray-700 hover:bg-cyan-400/60"
          {...sidebarDivider}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <main className="flex-1 min-h-0">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <LoadingText text={t('ide.loading')} />
                </div>
              }
            >
              <EditorPane />
            </Suspense>
          </main>
          {terminalOpen && (
            <div
              role="separator"
              aria-orientation="horizontal"
              className="h-1 shrink-0 cursor-row-resize touch-none bg-gray-700 hover:bg-cyan-400/60"
              {...terminalDivider}
            />
          )}
          {/* Always mounted: collapsing must not end the shell sessions. */}
          <div className={terminalOpen ? 'shrink-0' : 'hidden'} style={{ height: terminalHeight }}>
            <TerminalPanel key={workspaceId} workspaceId={workspaceId} />
          </div>
        </div>
      </div>
    </div>
  );
}
