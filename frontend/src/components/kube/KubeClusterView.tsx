import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, KubeCluster, KubeListRow } from '../../api/client';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { KubeResourceDrawer } from './KubeResourceDrawer';
import { columnsFor, KUBE_KIND_GROUPS, statusClasses } from './kubeKinds';
import { useKubeResources } from './hooks/useKubeResources';

interface Props {
  cluster: KubeCluster;
  onBack: () => void;
}

/**
 * Wert einer Tabellenzelle. Bewusst eine feste Zuordnung statt eines
 * dynamischen Zugriffs — so ist beim Lesen sichtbar, welche Spalte woher
 * kommt, und ein Tippfehler fällt beim Kompilieren auf.
 */
function cellOf(row: KubeListRow, col: Exclude<ReturnType<typeof columnsFor>[number], 'age'>): string {
  switch (col) {
    case 'namespace': return row.namespace ?? '—';
    case 'status': return row.status ?? '—';
    case 'ready': return row.ready ?? '—';
    case 'restarts': return row.restarts === undefined ? '—' : String(row.restarts);
    case 'node': return row.node ?? '—';
    case 'detail': return row.detail ?? '—';
    case 'message': return row.message ?? '—';
  }
}

/** Alter als kurze Angabe („3d", „5h", „12m"). */
function ageOf(createdAt?: string): string {
  if (!createdAt) return '—';
  const ms = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function KubeClusterView({ cluster, onBack }: Props) {
  const { t } = useTranslation();
  const [namespaces, setNamespaces] = useState<KubeListRow[]>([]);
  const [namespace, setNamespace] = useState<string | null>(cluster.defaultNamespace ?? null);
  const [kind, setKind] = useState('Pod');
  const [selected, setSelected] = useState<KubeListRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.listKubeNamespaces(cluster._id)
      .then((ns) => { if (!cancelled) setNamespaces(ns); })
      .catch(() => { if (!cancelled) setNamespaces([]); });
    return () => { cancelled = true; };
  }, [cluster._id]);

  // Nur die eine hier gerenderte Liste existiert — `active: true` ist damit
  // korrekt: „nicht sichtbar" heisst in diesem Baum „View unmounted"
  // (`ProjectDetail.tsx`/`CustomerDetail.tsx` rendern den Kube-Tab
  // ausschliesslich bedingt, `{tab === 'kube' && …}` statt versteckt per
  // CSS), und das räumt den Poll-Intervall über den Effekt-Cleanup im Hook
  // zuverlässig ab. Der Hintergrund-Tab-Fall steckt im Hook selbst
  // (`document.visibilityState`).
  const { rows, loading, error, reload } = useKubeResources(
    cluster._id, kind, namespace, true,
  );

  const columns = columnsFor(kind);

  return (
    <div className="flex gap-4">
      {/* linke Spalte: Namespace + Baum */}
      <aside className="w-56 shrink-0 space-y-4">
        <button type="button" className="text-sm text-gray-400 hover:text-gray-200" onClick={onBack}>
          ← {t('kube.view.back')}
        </button>
        <label className="block">
          <span className="text-xs text-gray-500">{t('kube.view.namespace')}</span>
          <select
            className="mt-1 w-full rounded-sm border border-gray-700 bg-gray-800 p-1 text-sm text-gray-200"
            value={namespace ?? ''}
            onChange={(e) => setNamespace(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">{t('kube.view.allNamespaces')}</option>
            {namespaces.map((ns) => (
              <option key={ns.name} value={ns.name}>{ns.name}</option>
            ))}
          </select>
        </label>
        {KUBE_KIND_GROUPS.map((group) => (
          <div key={group.labelKey}>
            <p className="text-xs uppercase tracking-wide text-gray-500">{t(group.labelKey)}</p>
            <ul className="mt-1 space-y-0.5">
              {group.kinds.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    className={
                      k === kind
                        ? 'w-full rounded-sm bg-gray-700 px-2 py-1 text-left text-sm text-gray-100'
                        : 'w-full rounded-sm px-2 py-1 text-left text-sm text-gray-300 hover:bg-gray-800'
                    }
                    onClick={() => { setKind(k); setSelected(null); }}
                  >
                    {k}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>

      {/* rechte Spalte: Tabelle */}
      <section className="min-w-0 flex-1">
        <div className="mb-2 flex items-center gap-3">
          <h3 className="text-sm font-medium text-gray-200">{kind}</h3>
          {loading && <span className="text-xs text-gray-500">{t('kube.view.loading')}</span>}
          {selected !== null && (
            <span className="text-xs text-gray-500">{t('kube.view.selected', { name: selected.name })}</span>
          )}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="ml-auto"
            onClick={() => { void reload(); }}
          >
            {t('kube.view.refresh')}
          </Button>
        </div>

        {error !== null && (
          <div className="mb-3 rounded-sm border border-red-700 bg-red-900/40 px-3 py-2 text-xs text-red-200">
            {t('common.errorLoading', { error })}
          </div>
        )}

        {error === null && !loading && rows.length === 0 && (
          <EmptyState message={t('kube.view.empty', { kind })} />
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-1 pr-3">{t('kube.col.name')}</th>
                  {columns.map((col) => (
                    <th key={col} className="py-1 pr-3">{t(`kube.col.${col}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.namespace ?? ''}/${row.name}`}
                    className="cursor-pointer border-t border-gray-800 hover:bg-gray-800/60"
                    onClick={() => setSelected(row)}
                  >
                    <td className="py-1 pr-3 font-medium text-gray-200">{row.name}</td>
                    {columns.map((col) => (
                      <td
                        key={col}
                        className={`py-1 pr-3 ${col === 'status' ? statusClasses(row.status) : 'text-gray-300'}`}
                      >
                        {col === 'age' ? ageOf(row.createdAt) : cellOf(row, col)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected !== null && (
          <KubeResourceDrawer
            cluster={cluster}
            kind={kind}
            row={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </section>
    </div>
  );
}
