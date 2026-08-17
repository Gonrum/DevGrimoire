import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, GitRepository } from '../api/client';
import { errorMessage } from '../lib/narrow';
import { useToast } from './Toast';
import { ProviderBadge } from './icons/ProviderIcon';

interface RepoInfo {
  repo: GitRepository;
  index: number;
  commitCount: number;
}

interface GitRepoWidgetProps {
  projectId: string;
  gitRepositories: GitRepository[];
  onNavigateToCommits?: () => void;
}

export default function GitRepoWidget({ projectId, gitRepositories, onNavigateToCommits }: GitRepoWidgetProps) {
  const { i18n } = useTranslation();
  const { showError } = useToast();
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [syncing, setSyncing] = useState<number | null>(null);
  // `formatSyncTime` rechnete mit `Date.now()` mitten im Render. Für die grobe
  // Relativzeit reicht der Zeitpunkt des Mountens.
  const [mountedAt] = useState(() => Date.now());

  const locale = i18n.language === 'de' ? 'de' : 'en';

  useEffect(() => {
    // Der Fehler wird pro Repo abgefangen: vorher riss ein einziger
    // fehlschlagender count-Call die ganze `Promise.all` mit — dann bekam
    // *kein* Repo eine Commit-Zahl und die Rejection blieb unbehandelt.
    void Promise.all(
      gitRepositories.map(async (repo, index) => {
        if (!repo.label) return { repo, index, commitCount: -1 };
        try {
          const { count } = await api.commits.count(projectId, repo.label);
          return { repo, index, commitCount: count };
        } catch {
          return { repo, index, commitCount: -1 };
        }
      }),
    ).then(setRepos);
  }, [projectId, gitRepositories]);

  const handleSync = async (repoIndex: number) => {
    setSyncing(repoIndex);
    try {
      await api.commits.sync(projectId, repoIndex);
      // Refresh counts
      const updated = await Promise.all(
        repos.map(async (r) => {
          if (!r.repo.label) return r;
          const { count } = await api.commits.count(projectId, r.repo.label);
          return { ...r, commitCount: count };
        }),
      );
      setRepos(updated);
    } finally {
      setSyncing(null);
    }
  };

  const getRepoUrl = (repo: GitRepository): string | null => {
    const base = repo.baseUrl ||
      (repo.provider === 'github' ? 'https://github.com' :
       repo.provider === 'gitlab' ? 'https://gitlab.com' :
       '');
    if (repo.provider === 'github' && repo.owner && repo.repo) {
      return `${base}/${repo.owner}/${repo.repo}`;
    }
    if (repo.provider === 'gitea' && repo.owner && repo.repo) {
      return base ? `${base}/${repo.owner}/${repo.repo}` : null;
    }
    if (repo.gitlabProjectId) {
      return `${base}/${repo.gitlabProjectId}`;
    }
    return null;
  };

  const getRepoName = (repo: GitRepository): string => {
    if (repo.provider === 'github') return `${repo.owner}/${repo.repo}`;
    if (repo.provider === 'gitea') return `${repo.owner}/${repo.repo}`;
    return repo.gitlabProjectId || `${repo.owner}/${repo.repo}`;
  };

  const formatSyncTime = (dateStr?: string): string => {
    if (!dateStr) return locale === 'de' ? 'Nie synchronisiert' : 'Never synced';
    const date = new Date(dateStr);
    const diff = Math.floor((mountedAt - date.getTime()) / 1000);
    if (diff < 60) return locale === 'de' ? 'Gerade eben' : 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return date.toLocaleDateString(locale === 'de' ? 'de-DE' : 'en-US', { day: '2-digit', month: '2-digit' });
  };

  if (gitRepositories.length === 0) return null;

  return (
    <div className="mt-4 border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900/50 border-b border-gray-800">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          {locale === 'de' ? 'Repositories' : 'Repositories'}
        </span>
        {onNavigateToCommits && (
          <button
            type="button"
            onClick={onNavigateToCommits}
            className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
          >
            {locale === 'de' ? 'Alle Commits' : 'All Commits'} &rarr;
          </button>
        )}
      </div>
      <div className="divide-y divide-gray-800/50">
        {gitRepositories.map((repo, i) => {
          const info = repos.find((r) => r.index === i);
          const repoUrl = getRepoUrl(repo);
          return (
            <div key={repo._id || i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/30 transition-colors">
              <ProviderBadge provider={repo.provider} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {repo.label && (
                    <span className="text-xs font-medium text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded">
                      {repo.label}
                    </span>
                  )}
                  {repoUrl ? (
                    <a
                      href={repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-gray-300 hover:text-violet-400 truncate transition-colors"
                    >
                      {getRepoName(repo)}
                    </a>
                  ) : (
                    <span className="text-sm text-gray-300 truncate">{getRepoName(repo)}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-gray-500 mt-0.5">
                  <span>{repo.defaultBranch || 'main'}</span>
                  <span>&middot;</span>
                  <span>{formatSyncTime(repo.lastSyncAt)}</span>
                  {info && info.commitCount >= 0 && (
                    <>
                      <span>&middot;</span>
                      <span>{info.commitCount} {info.commitCount === 1 ? 'Commit' : 'Commits'}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {repo.syncEnabled === false && (
                  <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">
                    {locale === 'de' ? 'Pausiert' : 'Paused'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    handleSync(i).catch((err: unknown) => {
                      showError(errorMessage(err, locale === 'de' ? 'Sync fehlgeschlagen' : 'Sync failed'));
                    });
                  }}
                  disabled={syncing !== null || repo.syncEnabled === false}
                  className="text-xs text-gray-500 hover:text-violet-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors px-1.5 py-0.5"
                  title="Sync"
                >
                  {syncing === i ? (
                    <span className="animate-spin inline-block">&#8635;</span>
                  ) : (
                    '&#8635;'
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
