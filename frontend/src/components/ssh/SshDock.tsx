import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation } from 'react-router-dom';
import { FolderGit2, Minus, Plus, Server, SquareTerminal, X } from 'lucide-react';
import {
  api,
  getCurrentAccessToken,
  SshConnectionListItem,
  Workspace,
} from '../../api/client';
import { safeRandomUUID } from '../../utils/randomId';
import SshTerminal, { TerminalState, TerminalTarget } from './SshTerminal';
import { deriveSshStatus } from './sshStatus';
import { useSshConnections } from './hooks/useSshConnections';

/** What a tab is attached to: a remote host via SSH, or a workspace's bash. */
type DockSource =
  | { kind: 'ssh'; connection: SshConnectionListItem }
  | { kind: 'workspace'; workspace: Workspace };

interface DockTab {
  key: string;
  source: DockSource;
  /** Stable per tab; for workspaces it keys the sidecar's PTY (re-attach). */
  target: TerminalTarget;
  /** 1 for the first session of a source, 2 for the second, … */
  ordinal: number;
  state: TerminalState;
}

function sourceId(source: DockSource): string {
  return source.kind === 'ssh' ? `ssh:${source.connection.id}` : `ws:${source.workspace._id}`;
}

function sourceLabel(source: DockSource): string {
  return source.kind === 'ssh' ? source.connection.label : source.workspace.name;
}

function sourceDetail(source: DockSource): string {
  if (source.kind === 'workspace') return source.workspace.path;
  const c = source.connection;
  return `${c.username}@${c.host}:${c.port}`;
}

/**
 * Active workspaces of a project. The result is tagged with the project it
 * belongs to, so a project switch shows nothing stale while the next list
 * loads — derived at render time instead of reset in an effect.
 */
function useProjectWorkspaces(projectId: string | null) {
  const [state, setState] = useState<{
    projectId: string;
    list: Workspace[];
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.workspaces
      .list(projectId, 'active')
      .then((list) => {
        if (!cancelled) setState({ projectId, list, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            projectId,
            list: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = projectId && state?.projectId === projectId ? state : null;
  return {
    workspaces: current?.list ?? [],
    loading: projectId !== null && current === null,
    error: current?.error ?? null,
  };
}

type PendingConfirm = { kind: 'tab'; key: string } | { kind: 'all' };

/** Project id of the current route, or null outside a project. */
function projectIdFromPath(pathname: string): string | null {
  const match = matchPath('/projects/:id/*', pathname) ?? matchPath('/projects/:id', pathname);
  const id = match?.params.id;
  // `/projects/new` is the create form, not a project.
  return id && id !== 'new' ? id : null;
}

/** Static class map — Tailwind cannot see dynamically built class names. */
const STATE_DOT: Record<TerminalState, string> = {
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-400',
  exited: 'bg-gray-500',
  disconnected: 'bg-red-500',
  error: 'bg-red-500',
};

/**
 * Floating terminal dock: a button (shown on project pages, or while
 * sessions are open) and a modal with one tab per session — either an SSH
 * shell on one of the project's servers, or a bash in one of its workspaces.
 *
 * Every tab's `<SshTerminal>` stays mounted while the modal is minimised or
 * another tab is in front — inactive panels are only made `invisible`, never
 * unmounted or `display:none`, so the WebSocket keeps running and the PTY is
 * not resized to 0×0. Sessions therefore survive navigation between pages
 * until their tab is closed.
 *
 * Esc is deliberately NOT intercepted (unlike `SshTerminalModal`): it belongs
 * to the shell (vim, less). Backdrop click minimises — nothing is lost — and
 * only closing a tab with a live session asks for confirmation.
 */
export default function SshDock() {
  const { t } = useTranslation();
  const location = useLocation();
  const projectId = projectIdFromPath(location.pathname);

  const [open, setOpen] = useState(false);
  const [tabs, setTabs] = useState<DockTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  const { data: connections, loading, error } = useSshConnections(
    projectId ? { projectId } : {},
  );
  const {
    workspaces,
    loading: workspacesLoading,
    error: workspacesError,
  } = useProjectWorkspaces(projectId);

  const openSession = useCallback((source: DockSource) => {
    const key = `dock-tab-${safeRandomUUID()}`;
    const target: TerminalTarget =
      source.kind === 'ssh'
        ? { kind: 'ssh', connectionId: source.connection.id }
        : { kind: 'workspace', workspaceId: source.workspace._id, sessionId: safeRandomUUID() };
    const id = sourceId(source);
    setTabs((prev) => {
      const ordinal =
        prev
          .filter((tab) => sourceId(tab.source) === id)
          .reduce((max, tab) => Math.max(max, tab.ordinal), 0) + 1;
      return [...prev, { key, source, target, ordinal, state: 'connecting' }];
    });
    setActiveKey(key);
    setPickerOpen(false);
  }, []);

  // Latest tab list for callbacks handed to long-lived terminals.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const removeTab = useCallback((key: string) => {
    const prev = tabsRef.current;
    const idx = prev.findIndex((tab) => tab.key === key);
    if (idx === -1) return;
    const next = prev.filter((tab) => tab.key !== key);
    tabsRef.current = next;
    setTabs(next);
    // Keep focus near the closed tab: its right neighbour, else the left one.
    setActiveKey((current) =>
      current === key ? ((next[idx] ?? next[idx - 1])?.key ?? null) : current,
    );
  }, []);

  const setTabState = useCallback((key: string, state: TerminalState) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.key === key && tab.state !== state ? { ...tab, state } : tab)),
    );
  }, []);

  const requestCloseTab = (tab: DockTab) => {
    if (tab.state === 'connected') setConfirm({ kind: 'tab', key: tab.key });
    else removeTab(tab.key);
  };

  const requestCloseAll = () => {
    if (tabs.some((tab) => tab.state === 'connected')) {
      setConfirm({ kind: 'all' });
      return;
    }
    setTabs([]);
    setActiveKey(null);
    minimize();
  };

  const applyConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === 'tab') {
      removeTab(confirm.key);
    } else {
      setTabs([]);
      setActiveKey(null);
      minimize();
    }
    setConfirm(null);
  };

  // An empty modal on a non-project page has nothing to offer, so it only
  // counts as open while there is a project or at least one session.
  const visible = open && (projectId !== null || tabs.length > 0);

  const minimize = () => {
    setPickerOpen(false);
    setOpen(false);
  };

  const liveCount = useMemo(
    () => tabs.filter((tab) => tab.state === 'connected' || tab.state === 'connecting').length,
    [tabs],
  );

  const showButton = !visible && (projectId !== null || tabs.length > 0);
  // Mount the overlay as soon as a session exists so minimising keeps it alive.
  const mountOverlay = visible || tabs.length > 0;

  const tabLabel = (tab: DockTab) => {
    const label = sourceLabel(tab.source);
    return tab.ordinal > 1 ? `${label} (${tab.ordinal})` : label;
  };

  const renderPicker = (compact: boolean) => {
    if (!projectId) {
      return <div className="px-3 py-2 text-xs text-gray-500">{t('ssh.dock.noProject')}</div>;
    }
    const itemClass = compact
      ? 'w-full text-left px-3 py-2 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent'
      : 'w-full text-left px-4 py-3 rounded-lg border border-gray-800 bg-gray-950/60 hover:border-emerald-500/60 hover:bg-gray-800/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-800 disabled:hover:bg-gray-950/60';
    const headingClass = compact
      ? 'px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-500 flex items-center gap-1.5'
      : 'text-xs uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-1.5';
    const note = (text: string, tone: 'muted' | 'error' = 'muted') => (
      <div
        className={`${compact ? 'px-3 py-1.5' : 'py-1'} text-xs ${
          tone === 'error' ? 'text-red-300' : 'text-gray-500'
        }`}
      >
        {text}
      </div>
    );

    const serverSection = (() => {
      if (loading) return note(t('common.loading'));
      if (error) return note(t('common.errorLoading', { error }), 'error');
      if (connections.length === 0) return note(t('ssh.dock.empty'));
      return (
        <ul className={compact ? '' : 'space-y-2'}>
          {connections.map((conn) => {
            const blocked = deriveSshStatus(conn) === 'fingerprint_pending';
            return (
              <li key={conn.id}>
                <button
                  type="button"
                  disabled={blocked}
                  title={blocked ? t('ssh.tab.connectBlockedFingerprint') : undefined}
                  onClick={() => openSession({ kind: 'ssh', connection: conn })}
                  className={itemClass}
                >
                  <div className="flex items-center gap-2 text-sm text-gray-200">
                    <span className="truncate">{conn.label}</span>
                    {conn.inheritedFromCustomerId && (
                      <span className="text-[10px] text-sky-300" title={t('ssh.tab.inheritedHint')}>
                        🔗 {t('ssh.tab.inheritedBadge')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-mono text-gray-500 truncate">
                    {conn.username}@{conn.host}:{conn.port}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      );
    })();

    const workspaceSection = (() => {
      if (workspacesLoading) return note(t('common.loading'));
      if (workspacesError) return note(t('common.errorLoading', { error: workspacesError }), 'error');
      if (workspaces.length === 0) return note(t('ssh.dock.emptyWorkspaces'));
      return (
        <ul className={compact ? '' : 'space-y-2'}>
          {workspaces.map((ws) => (
            <li key={ws._id}>
              <button
                type="button"
                onClick={() => openSession({ kind: 'workspace', workspace: ws })}
                className={itemClass}
              >
                <div className="flex items-center gap-2 text-sm text-gray-200">
                  <span className="truncate">{ws.name}</span>
                  {ws.branch && (
                    <span className="text-[10px] font-mono text-violet-300 truncate">{ws.branch}</span>
                  )}
                </div>
                <div className="text-xs font-mono text-gray-500 truncate">{ws.path}</div>
              </button>
            </li>
          ))}
        </ul>
      );
    })();

    return (
      <div className={compact ? 'py-1' : 'space-y-5'}>
        <section>
          <div className={headingClass}>
            <Server className="w-3 h-3" /> {t('ssh.dock.sectionServers')}
          </div>
          {serverSection}
        </section>
        <section className={compact ? 'border-t border-gray-800 mt-1' : ''}>
          <div className={headingClass}>
            <FolderGit2 className="w-3 h-3" /> {t('ssh.dock.sectionWorkspaces')}
          </div>
          {workspaceSection}
        </section>
      </div>
    );
  };

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;

  return (
    <>
      {/* Floating button — stacked above the ChatDock button (bottom-right). */}
      {showButton && (
        <button
          type="button"
          aria-label={t('ssh.dock.openButton')}
          title={t('ssh.dock.openButton')}
          onClick={() => setOpen(true)}
          className="fixed bottom-20 right-6 z-50 bg-emerald-700 hover:bg-emerald-600 text-white rounded-full shadow-lg shadow-emerald-900/40 p-3 transition-transform hover:scale-105"
        >
          <SquareTerminal className="w-5 h-5" />
          {tabs.length > 0 && (
            <span
              className={`absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full text-[10px] font-semibold flex items-center justify-center border border-gray-900 ${
                liveCount > 0 ? 'bg-emerald-400 text-gray-900' : 'bg-gray-600 text-gray-100'
              }`}
            >
              {tabs.length}
            </span>
          )}
        </button>
      )}

      {mountOverlay && (
        <div
          className={`fixed inset-0 z-60 flex items-center justify-center bg-black/50 backdrop-blur-xs ${
            visible ? '' : 'invisible pointer-events-none'
          }`}
          aria-hidden={!visible}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) minimize();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('ssh.dock.title')}
            className="relative bg-gray-900 border border-emerald-500/40 rounded-xl shadow-2xl shadow-emerald-500/10 w-[95vw] sm:w-[80vw] h-[90vh] flex flex-col overflow-hidden"
          >
            {/* Header: tab strip + window actions */}
            <div className="flex items-stretch shrink-0 border-b border-emerald-500/30 bg-emerald-500/5">
              <div className="flex items-center gap-2 px-4 text-sm font-medium text-emerald-300 shrink-0">
                <SquareTerminal className="w-4 h-4" />
                <span className="hidden sm:inline">{t('ssh.dock.title')}</span>
              </div>
              <div className="flex-1 min-w-0 flex items-stretch overflow-x-auto" role="tablist">
                {tabs.map((tab) => {
                  const isActive = tab.key === activeKey;
                  return (
                    <div
                      key={tab.key}
                      role="tab"
                      aria-selected={isActive}
                      className={`group flex items-center gap-2 pl-3 pr-1 border-r border-gray-800 text-xs cursor-pointer shrink-0 max-w-56 ${
                        isActive
                          ? 'bg-gray-900 text-gray-100 border-b-2 border-b-emerald-400'
                          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                      }`}
                      onClick={() => setActiveKey(tab.key)}
                      title={sourceDetail(tab.source)}
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${STATE_DOT[tab.state]}`} />
                      {tab.source.kind === 'ssh' ? (
                        <Server className="w-3 h-3 shrink-0 text-gray-500" />
                      ) : (
                        <FolderGit2 className="w-3 h-3 shrink-0 text-violet-400" />
                      )}
                      <span className="truncate py-2.5">{tabLabel(tab)}</span>
                      <button
                        type="button"
                        aria-label={t('ssh.dock.closeTab', { label: tabLabel(tab) })}
                        title={t('ssh.dock.closeTab', { label: tabLabel(tab) })}
                        onClick={(e) => {
                          e.stopPropagation();
                          requestCloseTab(tab);
                        }}
                        className="p-1 rounded-sm text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="relative flex items-center gap-1 px-2 shrink-0">
                {tabs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPickerOpen((v) => !v)}
                    className="p-1.5 rounded-sm text-gray-400 hover:text-emerald-300 hover:bg-gray-800"
                    title={t('ssh.dock.newTab')}
                    aria-label={t('ssh.dock.newTab')}
                    aria-expanded={pickerOpen}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={minimize}
                  className="p-1.5 rounded-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800"
                  title={t('ssh.dock.minimize')}
                  aria-label={t('ssh.dock.minimize')}
                >
                  <Minus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={requestCloseAll}
                  className="p-1.5 rounded-sm text-gray-400 hover:text-red-300 hover:bg-gray-800"
                  title={t('ssh.dock.closeAll')}
                  aria-label={t('ssh.dock.closeAll')}
                >
                  <X className="w-4 h-4" />
                </button>
                {pickerOpen && visible && (
                  <div className="absolute right-2 top-full mt-1 z-10 w-72 max-h-80 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
                    {renderPicker(true)}
                  </div>
                )}
              </div>
            </div>

            {/* Body: all terminals stacked; only the active one is visible. */}
            <div className="relative flex-1 min-h-0">
              {tabs.length === 0 && (
                <div className="h-full overflow-y-auto p-6">
                  <div className="max-w-xl mx-auto">
                    <div className="text-sm text-gray-300 mb-3">{t('ssh.dock.pickTitle')}</div>
                    {renderPicker(false)}
                  </div>
                </div>
              )}
              {tabs.map((tab) => {
                const isActive = visible && tab.key === activeTab?.key;
                return (
                  <div
                    key={tab.key}
                    role="tabpanel"
                    className={`absolute inset-0 ${isActive ? '' : 'invisible pointer-events-none'}`}
                  >
                    <SshTerminal
                      target={tab.target}
                      connectionLabel={tabLabel(tab)}
                      hostInfo={sourceDetail(tab.source)}
                      authToken={getCurrentAccessToken()}
                      active={isActive}
                      hint={t('ssh.dock.hint')}
                      heightClassName="h-full"
                      onClose={() => removeTab(tab.key)}
                      onConnectionStateChange={(state) => setTabState(tab.key, state)}
                    />
                  </div>
                );
              })}
            </div>

            {confirm && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
                <div className="bg-gray-900 border border-red-500/50 rounded-xl shadow-2xl max-w-md w-full mx-4 p-5">
                  <div className="text-sm font-medium text-red-300 mb-2">
                    {confirm.kind === 'all'
                      ? t('ssh.dock.confirmCloseAllTitle')
                      : t('ssh.terminal.confirmCloseTitle')}
                  </div>
                  <div className="text-xs text-gray-400 mb-4">
                    {confirm.kind === 'all'
                      ? t('ssh.dock.confirmCloseAllBody', {
                          count: tabs.filter((tab) => tab.state === 'connected').length,
                        })
                      : t('ssh.terminal.confirmCloseBody')}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="px-3 py-1.5 text-xs rounded-sm border border-gray-700 text-gray-300 hover:bg-gray-800"
                      onClick={() => setConfirm(null)}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      className="px-3 py-1.5 text-xs rounded-sm bg-red-600 text-white hover:bg-red-500"
                      onClick={applyConfirm}
                    >
                      {t('ssh.terminal.confirmCloseConfirm')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
