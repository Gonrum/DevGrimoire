import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, KubeCluster, KubeConnectionTestResult } from '../../api/client';
import { errorMessage } from '../../lib/narrow';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { LoadingText } from '../ui/LoadingSpinner';
import { useToast } from '../Toast';
import { useKubeClusters } from './hooks/useKubeClusters';
import { kubeStatusClasses, kubeStatusOf, KubeClusterStatus } from './kubeStatus';
import { KubeClusterForm } from './KubeClusterForm';

const STATUS_KEY: Record<KubeClusterStatus, string> = {
  ok: 'kube.status.ok',
  error: 'kube.status.error',
  never_tested: 'kube.status.never_tested',
};

export interface KubeClustersTabProps {
  scope: { projectId: string } | { customerId: string };
}

export function KubeClustersTab({ scope }: KubeClustersTabProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const normalized =
    'projectId' in scope ? { projectId: scope.projectId } : { customerId: scope.customerId };
  const { clusters, loading, error, reload } = useKubeClusters(normalized);
  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState<Record<string, KubeConnectionTestResult>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  async function runTest(cluster: KubeCluster) {
    setBusyId(cluster._id);
    try {
      const result = await api.testKubeCluster(cluster._id);
      setResults((prev) => ({ ...prev, [cluster._id]: result }));
      if (!result.ok && result.error) showError(result.error);
      await reload();
    } catch (err) {
      showError(errorMessage(err, t('kube.tab.testFailed')));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(cluster: KubeCluster) {
    setBusyId(cluster._id);
    try {
      await api.deleteKubeCluster(cluster._id);
      showSuccess(t('kube.tab.deleted'));
      await reload();
    } catch (err) {
      showError(errorMessage(err, t('kube.tab.deleteFailed')));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium text-gray-200">{t('kube.tab.title')}</h2>
        {!creating && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            + {t('kube.tab.addCluster')}
          </Button>
        )}
      </div>

      {creating && (
        <KubeClusterForm
          scope={normalized}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading && <LoadingText />}

      {error !== null && !loading && (
        <div className="rounded border border-red-700 bg-red-900/40 px-3 py-2 text-xs text-red-200">
          {t('common.errorLoading', { error })}
        </div>
      )}

      {!loading && error === null && clusters.length === 0 && !creating && (
        <EmptyState message={t('kube.tab.empty')} />
      )}

      {!loading && clusters.length > 0 && (
        <ul className="space-y-2">
          {clusters.map((cluster) => {
            const status = kubeStatusOf(cluster);
            const result = results[cluster._id];
            return (
              <li key={cluster._id} className="rounded border border-gray-800 bg-gray-900/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-200">{cluster.label}</span>
                  <Badge color={kubeStatusClasses(status)}>{t(STATUS_KEY[status])}</Badge>
                  {cluster.readOnly && <Badge>{t('kube.tab.readOnly')}</Badge>}
                  {cluster.transport === 'ssh-tunnel' && <Badge>{t('kube.tab.viaSsh')}</Badge>}
                  {cluster.allowInsecureTls && (
                    <Badge color="bg-amber-500/15 text-amber-300 border-amber-500/30">
                      {t('kube.tab.insecureTls')}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {cluster.contextName} · {cluster.clusterServer}
                </p>
                {cluster.lastConnectError && (
                  <p className="mt-1 text-xs text-red-400">{cluster.lastConnectError.message}</p>
                )}
                {result?.ok && (
                  <p className="mt-1 text-xs text-emerald-300">
                    {t('kube.tab.testSuccess', { version: result.serverVersion ?? '?' })}
                    {' · '}
                    {result.canWrite ? t('kube.tab.canWrite') : t('kube.tab.readOnlyAccess')}
                  </p>
                )}
                <div className="mt-2 flex gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busyId === cluster._id}
                    onClick={() => void runTest(cluster)}
                  >
                    {busyId === cluster._id ? '…' : t('kube.tab.test')}
                  </Button>
                  <Button
                    size="xs"
                    variant="danger"
                    disabled={busyId === cluster._id}
                    onClick={() => void remove(cluster)}
                  >
                    {t('kube.tab.delete')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
