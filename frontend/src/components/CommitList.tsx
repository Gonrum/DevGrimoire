import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, CommitEntry, GitRepository } from '../api/client';
import Badge from './ui/Badge';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

function timeAgo(dateStr: string, locale: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return locale === 'de' ? 'gerade eben' : 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

const PROVIDER_ICONS: Record<string, string> = {
  github: 'GH',
  gitlab: 'GL',
};

const PROVIDER_COLORS: Record<string, string> = {
  github: 'bg-gray-700 text-white',
  gitlab: 'bg-orange-900/60 text-orange-300',
};

interface CommitListProps {
  projectId: string;
  gitRepositories?: GitRepository[];
}

export default function CommitList({ projectId, gitRepositories }: CommitListProps) {
  const { i18n } = useTranslation();
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [activeRepoLabel, setActiveRepoLabel] = useState<string | null>(null);
  const limit = 50;

  const locale = i18n.language === 'de' ? 'de' : 'en';

  const repoLabels = useMemo(() => {
    if (!gitRepositories) return [];
    return gitRepositories
      .map((r) => r.label)
      .filter((l): l is string => !!l);
  }, [gitRepositories]);

  const loadCommits = useCallback(async () => {
    setLoading(true);
    try {
      if (search.trim()) {
        const results = await api.commits.search(projectId, search, limit);
        const filtered = activeRepoLabel ? results.filter((c) => c.repoLabel === activeRepoLabel) : results;
        setCommits(filtered);
        setTotal(filtered.length);
      } else {
        const [results, countRes] = await Promise.all([
          api.commits.list(projectId, { limit, offset, repoLabel: activeRepoLabel || undefined }),
          api.commits.count(projectId),
        ]);
        setCommits(results);
        setTotal(countRes.count);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectId, search, offset, activeRepoLabel]);

  useEffect(() => {
    loadCommits();
  }, [loadCommits]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.commits.sync(projectId);
      setOffset(0);
      await loadCommits();
    } finally {
      setSyncing(false);
    }
  };

  const hasRepos = gitRepositories && gitRepositories.length > 0;

  if (!hasRepos) {
    return (
      <EmptyState
        message={locale === 'de'
          ? 'Keine Repositories konfiguriert. Konfiguriere GitHub- oder GitLab-Repositories in den Projekt-Einstellungen, um Commits zu synchronisieren.'
          : 'No repositories configured. Configure GitHub or GitLab repositories in project settings to sync commits.'
        }
      />
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder={locale === 'de' ? 'Commits durchsuchen...' : 'Search commits...'}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-violet-500 focus:outline-none"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing
            ? (locale === 'de' ? 'Synchronisiere...' : 'Syncing...')
            : (locale === 'de' ? 'Sync' : 'Sync')
          }
        </Button>
      </div>

      {repoLabels.length > 1 && (
        <div className="flex gap-1.5 mb-4 flex-wrap">
          <button
            type="button"
            onClick={() => { setActiveRepoLabel(null); setOffset(0); }}
            className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
              activeRepoLabel === null
                ? 'bg-violet-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {locale === 'de' ? 'Alle' : 'All'}
          </button>
          {repoLabels.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => { setActiveRepoLabel(label); setOffset(0); }}
              className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                activeRepoLabel === label
                  ? 'bg-violet-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm py-4">Loading...</p>
      ) : commits.length === 0 ? (
        <EmptyState
          message={search
            ? (locale === 'de' ? 'Keine Ergebnisse' : 'No results')
            : (locale === 'de' ? 'Noch keine Commits. Klicke "Sync" um Commits vom Repository zu laden.' : 'No commits yet. Click "Sync" to fetch commits from the repository.')
          }
        />
      ) : (
        <>
          <div className="space-y-1">
            {commits.map((commit) => {
              const firstLine = commit.message.split('\n')[0];
              return (
                <div
                  key={commit._id}
                  className="flex items-start gap-3 py-2 px-3 rounded-lg hover:bg-gray-800/50 transition-colors group"
                >
                  <Badge color={PROVIDER_COLORS[commit.provider] || 'bg-gray-700 text-gray-300'} rounded="full">
                    {PROVIDER_ICONS[commit.provider] || commit.provider}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {commit.url ? (
                        <a
                          href={commit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-violet-400 hover:text-violet-300 shrink-0"
                        >
                          {commit.sha.substring(0, 8)}
                        </a>
                      ) : (
                        <span className="font-mono text-xs text-gray-500 shrink-0">
                          {commit.sha.substring(0, 8)}
                        </span>
                      )}
                      <span className="text-sm text-gray-200 truncate">{firstLine}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5 flex-wrap">
                      <span>{commit.authorName}</span>
                      <span>{timeAgo(commit.committedAt, locale)}</span>
                      {(commit.additions != null || commit.deletions != null || commit.changedFiles != null) && (
                        <span className="text-gray-600">
                          {commit.changedFiles != null && (
                            <span className="text-gray-500">{commit.changedFiles} {commit.changedFiles === 1 ? 'file' : 'files'}</span>
                          )}
                          {commit.changedFiles != null && (commit.additions != null || commit.deletions != null) && (
                            <span className="mx-0.5">·</span>
                          )}
                          {commit.additions != null && <span className="text-green-500">+{commit.additions}</span>}
                          {commit.additions != null && commit.deletions != null && <span className="mx-0.5">/</span>}
                          {commit.deletions != null && <span className="text-red-400">-{commit.deletions}</span>}
                        </span>
                      )}
                      {commit.repoLabel && repoLabels.length > 1 && !activeRepoLabel && (
                        <span className="text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded text-[10px] font-medium">
                          {commit.repoLabel}
                        </span>
                      )}
                      {commit.branch && (
                        <Badge color="bg-gray-800 text-gray-400" rounded="full">
                          {commit.branch}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {!search && total > limit && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-800">
              <span className="text-xs text-gray-500">
                {offset + 1}-{Math.min(offset + limit, total)} / {total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                >
                  &larr;
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= total}
                >
                  &rarr;
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
