import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Workspace } from '../api/client';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/narrow';
import { FileTree } from './FileTree';
import { useIdeStore } from './ide-store';

// Monaco lives in its own chunk: the header and the file tree show up before it has loaded.
const EditorPane = lazy(() => import('./EditorPane').then((m) => ({ default: m.EditorPane })));

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; workspace: Workspace }
  | { kind: 'notFound' }
  | { kind: 'forbidden' }
  | { kind: 'inactive'; workspace: Workspace }
  | { kind: 'error'; message: string };

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
  const { showError } = useToast();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const setWorkspace = useIdeStore((s) => s.setWorkspace);
  const openFile = useIdeStore((s) => s.openFile);
  const activePath = useIdeStore((s) => s.activePath);
  const sidebarWidth = useIdeStore((s) => s.sidebarWidth);

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

  const { workspace } = state;
  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-200">
      <header className="flex items-center gap-3 px-3 h-10 shrink-0 bg-gray-800 border-b border-gray-700 text-sm">
        <Link to={`/projects/${workspace.projectId}`} className="text-cyan-400 hover:text-cyan-300">
          ← {t('ide.backToProject')}
        </Link>
        <span className="font-medium truncate">{workspace.name}</span>
        <span className="text-gray-500 text-xs font-mono truncate">{workspace.branch}</span>
      </header>
      <div className="flex flex-1 min-h-0">
        <aside
          className="shrink-0 border-r border-gray-700 bg-gray-900 min-h-0"
          style={{ width: sidebarWidth }}
        >
          <FileTree
            key={workspaceId}
            workspaceId={workspaceId}
            activePath={activePath}
            onOpenFile={(path, size) => {
              openFile(path, size).catch((err: unknown) => showError(errorMessage(err)));
            }}
          />
        </aside>
        <main className="flex-1 min-w-0 min-h-0">
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
      </div>
    </div>
  );
}
