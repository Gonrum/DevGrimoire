import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, OAuthConnection } from '../../api/client';
import { errorMessage } from '../../lib/narrow';
import McpConnectBox from '../McpConnectBox';
import ConfirmButton from '../ui/ConfirmButton';
import { SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

/**
 * Settings → Connected apps: MCP clients the user granted access via OAuth,
 * each revocable (takes effect on the next request; open MCP streams of the
 * connection are closed by the server). The "Connect" box sits on top.
 */
export default function ConnectedAppsSettings() {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  const [connections, setConnections] = useState<OAuthConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectNames, setProjectNames] = useState<Map<string, string>>(new Map());

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true);
    try {
      const list = await api.oauth.connections();
      if (!isCancelled()) {
        setConnections(list);
        setError(null);
      }
    } catch (e) {
      if (!isCancelled()) setError(errorMessage(e, t('common.error')));
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load(() => cancelled);
    })();
    // Names for the scope column only; without them the column shows a count.
    api.projects.list()
      .then((projects) => {
        if (!cancelled) setProjectNames(new Map(projects.map((p) => [p._id, p.name])));
      })
      .catch(() => { /* scope falls back to a count */ });
    return () => { cancelled = true; };
  }, [load]);

  const revoke = async (id: string) => {
    try {
      await api.oauth.revokeConnection(id);
      setConnections((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError(errorMessage(e, t('common.error')));
    }
  };

  const scopeLabel = (c: OAuthConnection): string => {
    if (c.projectScopeMode === 'all') return t('connectedApps.scopeAll');
    if (c.projectScopeMode === 'none') return t('connectedApps.scopeNone');
    const names = c.allowedProjectIds.map((id) => projectNames.get(id));
    if (names.every((n): n is string => typeof n === 'string')) return names.join(', ');
    return t('connectedApps.scopeProjects', { count: c.allowedProjectIds.length });
  };

  return (
    <>
      <SettingsTabHeader description={t('connectedApps.description')} />

      <div className="mb-6">
        <McpConnectBox />
      </div>

      {error && (
        <div className="mb-4 rounded-sm border border-red-700 bg-red-900/50 px-4 py-2 text-red-300">{error}</div>
      )}

      <SettingsSection
        title={t('connectedApps.listTitle')}
        meta={connections.length > 0 ? `${connections.length}` : undefined}
      >
        {loading ? (
          <div className="py-8 text-center text-sm text-gray-500">{t('common.loading')}</div>
        ) : connections.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">{t('connectedApps.empty')}</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-800">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-800/50">
                  <th className="px-4 py-2 text-left font-medium text-gray-400">{t('connectedApps.client')}</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-400">{t('connectedApps.scope')}</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-400">{t('connectedApps.created')}</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-400">{t('connectedApps.lastUsed')}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id} className="border-b border-gray-800 last:border-0">
                    <td className="px-4 py-3 text-gray-200">{c.clientName}</td>
                    <td className="px-4 py-3 text-gray-400">{scopeLabel(c)}</td>
                    <td className="px-4 py-3 text-gray-400">
                      {c.createdAt ? new Date(c.createdAt).toLocaleDateString(dateLocale) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString(dateLocale) : t('common.neverUsed')}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ConfirmButton
                        onConfirm={() => revoke(c.id)}
                        label={t('connectedApps.revoke')}
                        confirmLabel={t('connectedApps.revokeConfirm')}
                        variant="danger"
                        size="xs"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </>
  );
}
