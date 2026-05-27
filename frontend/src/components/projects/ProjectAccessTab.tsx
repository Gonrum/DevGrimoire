import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ProjectAccess } from '../../api/client';
import Badge from '../ui/Badge';
import { LoadingText } from '../ui/LoadingSpinner';

interface Props {
  projectId: string;
}

/**
 * T-337: per-project "who can access" view. Admin-only — the backend
 * endpoint is admin-guarded, so non-admins see a 401 and we render a
 * friendly fallback instead of an error toast.
 */
export default function ProjectAccessTab({ projectId }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<ProjectAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.projects.access(projectId)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err.message.toLowerCase().includes('forbid') || err.message.includes('401') || err.message.includes('403')) {
          setForbidden(true);
        } else {
          setError(err.message);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  if (loading) return <LoadingText />;
  if (forbidden) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
        {t('projectAccess.adminOnly')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded border border-red-800 bg-red-950/30 p-4 text-sm text-red-300">
        {error}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <p className="text-xs text-gray-500">{t('projectAccess.intro')}</p>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-300">
          {t('projectAccess.usersHeading')} <span className="ml-1 text-xs text-gray-500">({data.users.length})</span>
        </h3>
        {data.users.length === 0 ? (
          <p className="text-xs text-gray-500">{t('projectAccess.usersEmpty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-800/50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.user')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.role')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.scope')}</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u._id} className="border-t border-gray-800">
                    <td className="px-4 py-2 text-gray-200">{u.username}</td>
                    <td className="px-4 py-2 text-gray-400">{u.role}</td>
                    <td className="px-4 py-2">
                      <ScopeBadge mode={u.projectScopeMode} allowedCount={u.allowedProjectIds?.length ?? 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-300">
          {t('projectAccess.keysHeading')} <span className="ml-1 text-xs text-gray-500">({data.apiKeys.length})</span>
        </h3>
        {data.apiKeys.length === 0 ? (
          <p className="text-xs text-gray-500">{t('projectAccess.keysEmpty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-800/50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.keyName')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.owner')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.prefix')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.scope')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('projectAccess.tools')}</th>
                </tr>
              </thead>
              <tbody>
                {data.apiKeys.map((k) => (
                  <tr key={k._id} className="border-t border-gray-800">
                    <td className="px-4 py-2 text-gray-200">{k.name}</td>
                    <td className="px-4 py-2 text-gray-400">{k.ownerUsername ?? '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-500">{k.prefix}...</td>
                    <td className="px-4 py-2">
                      <ScopeBadge mode={k.projectScopeMode} allowedCount={k.allowedProjectIds?.length ?? 0} />
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400">
                      {Array.isArray(k.allowedTools)
                        ? t('projectAccess.toolsScoped', { count: k.allowedTools.length })
                        : t('projectAccess.toolsAll')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ScopeBadge({ mode, allowedCount }: { mode?: string; allowedCount: number }) {
  const { t } = useTranslation();
  if (mode === 'all') return <Badge color="bg-green-900/60 text-green-300">{t('projectAccess.scopeAll')}</Badge>;
  if (mode === 'allowlist') return <Badge color="bg-amber-900/60 text-amber-300">{t('projectAccess.scopeAllowlist', { count: allowedCount })}</Badge>;
  if (mode === 'none') return <Badge color="bg-red-900/60 text-red-300">{t('projectAccess.scopeNone')}</Badge>;
  return <Badge color="bg-gray-800 text-gray-400">—</Badge>;
}
