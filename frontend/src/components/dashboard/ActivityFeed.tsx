import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, api, Project } from '../../api/client';
import { useDashboardEvents } from '../../hooks/useProjectEvents';
import Badge from '../ui/Badge';

interface Props {
  projectsById: Record<string, Project>;
}

// Map an Activity row to a click-through URL into the matching detail view.
// Falls back to the project page when the entity-specific deep-link isn't
// known. Activities without projectId/customerId (e.g. global notifications)
// stay non-navigable.
function activityLinkFor(act: Activity): string | null {
  const eid = act.entityId;
  if (act.entity === 'todo' && eid) {
    return act.projectId ? `/projects/${act.projectId}?tab=todos` : `/todos/${eid}`;
  }
  if (act.entity === 'knowledge' && act.projectId) {
    return `/projects/${act.projectId}?tab=knowledge${eid ? `&knowledgeId=${eid}` : ''}`;
  }
  if (act.entity === 'milestone' && act.projectId) {
    return `/projects/${act.projectId}?tab=milestones`;
  }
  if (act.entity === 'changelog' && act.projectId) {
    return `/projects/${act.projectId}?tab=changelog`;
  }
  if (act.entity === 'session' && act.projectId) {
    return `/projects/${act.projectId}?tab=sessions`;
  }
  if (act.entity === 'manual' && act.projectId) {
    return `/projects/${act.projectId}?tab=manual${eid ? `&manualId=${eid}` : ''}`;
  }
  if (act.entity === 'research' && act.projectId) {
    return `/projects/${act.projectId}?tab=research${eid ? `&researchId=${eid}` : ''}`;
  }
  if (act.entity === 'snippet' && act.projectId) {
    return `/projects/${act.projectId}?tab=snippets${eid ? `&snippetId=${eid}` : ''}`;
  }
  if (act.entity === 'feature' && act.projectId) {
    return `/projects/${act.projectId}?tab=features`;
  }
  if (act.entity === 'schema' && act.projectId) {
    return `/projects/${act.projectId}?tab=schemas`;
  }
  if (act.entity === 'workspace' && act.projectId) {
    return `/projects/${act.projectId}?tab=workspaces`;
  }
  if (act.entity === 'healthcheck' && act.customerId) {
    return `/customers/${act.customerId}?tab=monitoring`;
  }
  if (act.entity === 'ssh-connection' && act.customerId) {
    return `/customers/${act.customerId}?tab=ssh`;
  }
  if (act.projectId) return `/projects/${act.projectId}`;
  if (act.customerId) return `/customers/${act.customerId}`;
  return null;
}

const ENTITY_ICON: Record<string, string> = {
  todo: '✓',
  knowledge: '📚',
  milestone: '🏁',
  changelog: '📝',
  session: '🌀',
  manual: '📖',
  research: '🔬',
  snippet: '✂',
  feature: '⚡',
  schema: '⛁',
  workspace: '🗂',
  healthcheck: '❤',
  'ssh-connection': '🔐',
  notification: '🔔',
  project: '📁',
  customer: '🏢',
};

function timeAgo(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return locale === 'de' ? `${diffSec}s` : `${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return locale === 'de' ? `vor ${diffMin}m` : `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return locale === 'de' ? `vor ${diffH}h` : `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return locale === 'de' ? `vor ${diffD}d` : `${diffD}d ago`;
  return new Date(iso).toLocaleDateString(locale === 'de' ? 'de-DE' : 'en-US');
}

export default function ActivityFeed({ projectsById }: Props) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const list = await api.activities.listGlobal({ limit: 50 });
      setItems(list);
    } catch {
      // Silent — dashboard tile shouldn't blow up if the feed call fails.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The dashboard event hook already fires on any project-scoped change.
  // Activity rows are written from PROJECT_CHANGED, so a fresh load on
  // any event gives us live-update parity with PendingQuestionsWidget.
  useDashboardEvents(() => load());

  if (loading) return null;
  if (items.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="text-lg sm:text-xl font-bold mb-4">{t('dashboard.activity')}</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
        {items.map((act) => {
          const url = activityLinkFor(act);
          const icon = ENTITY_ICON[act.entity] ?? '•';
          const scopeName = act.projectId
            ? projectsById[act.projectId]?.name
            : act.customerId
              ? t('dashboard.activityCustomerScope')
              : null;
          const rowInner = (
            <>
              <span className="text-base shrink-0" aria-hidden>{icon}</span>
              <span className="text-xs text-gray-500 shrink-0 font-mono" title={act.createdAt}>
                {timeAgo(act.createdAt, i18n.language)}
              </span>
              <span className="text-sm text-gray-200 truncate flex-1">
                {act.summary || `${act.entity} ${act.action}`}
              </span>
              {act.username && (
                <span className="text-xs text-gray-500 shrink-0">{act.username}</span>
              )}
              {scopeName && (
                <Badge color="bg-gray-800 text-gray-400" rounded="full" className="text-xs shrink-0">
                  {scopeName}
                </Badge>
              )}
            </>
          );
          return url ? (
            <Link key={act._id} to={url} className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 hover:bg-gray-800/50 transition-colors">
              {rowInner}
            </Link>
          ) : (
            <div key={act._id} className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2">
              {rowInner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
