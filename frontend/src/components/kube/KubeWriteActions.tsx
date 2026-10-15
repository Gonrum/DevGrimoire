import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, KubeCluster, KubeListRow } from '../../api/client';
import { errorMessage, isRecord } from '../../lib/narrow';
import { useToast } from '../Toast';
import ConfirmButton from '../ui/ConfirmButton';

interface Props {
  cluster: KubeCluster;
  kind: string;
  row: KubeListRow;
  /** Das volle Objekt aus describe — liefert spec.replicas und spec.unschedulable. */
  object?: unknown;
  onDone: () => void;
  /** Nach einem erfolgreichen Löschen: die Ressource gibt es nicht mehr, der Drawer schliesst. */
  onDeleted?: () => void;
}

// Spiegel der Whitelists in backend/src/kube/kube-writes.service.ts; der
// Server entscheidet verbindlich, die UI blendet nur Unzulässiges aus.
const SCALABLE = ['Deployment', 'StatefulSet'];
const RESTARTABLE = ['Deployment', 'StatefulSet', 'DaemonSet'];
const DELETABLE = ['Pod', 'Job'];

function specOf(object: unknown): Record<string, unknown> | undefined {
  return isRecord(object) && isRecord(object.spec) ? object.spec : undefined;
}

/** Aktuelle Replica-Zahl, sofern das Objekt geladen ist und sie trägt. */
function replicasOf(object: unknown): number | undefined {
  const r = specOf(object)?.replicas;
  return typeof r === 'number' && Number.isInteger(r) ? r : undefined;
}

/** Cordon-Zustand einer Node; undefined, solange das Objekt nicht geladen ist. */
function unschedulableOf(object: unknown): boolean | undefined {
  if (!isRecord(object)) return undefined;
  return specOf(object)?.unschedulable === true;
}

export function KubeWriteActions({ cluster, kind, row, object, onDone, onDeleted }: Props) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const currentReplicas = replicasOf(object);
  const [replicas, setReplicas] = useState(currentReplicas !== undefined ? String(currentReplicas) : '1');
  // Vorbelegung mit der aktuellen Replica-Zahl, sobald describe sie liefert
  // (und nach jedem Neuladen). Während des Renderns statt im Effekt — dasselbe
  // Muster wie der Reset im KubeResourceDrawer.
  const [prefilledFrom, setPrefilledFrom] = useState(currentReplicas);
  if (currentReplicas !== prefilledFrom) {
    setPrefilledFrom(currentReplicas);
    setReplicas(currentReplicas !== undefined ? String(currentReplicas) : '1');
  }
  const [busy, setBusy] = useState(false);

  // Auf einem read-only Cluster gibt es die Leiste gar nicht — kein
  // ausgegrauter Knopf, der zur Frage einlädt, warum man ihn nicht drücken
  // darf. Das read-only-Badge an der Cluster-Zeile erklärt die Lage.
  if (cluster.readOnly) return null;

  const ns = row.namespace;
  /** Der Bestätigungstext wiederholt Cluster, Namespace und Namen — der
   *  billigste wirksame Schutz gegen den falschen Cluster im falschen Tab. */
  const target = `${cluster.label} · ${ns ?? '—'} · ${row.name}`;

  const replicaCount = Number(replicas);
  const replicasValid = replicas.trim() !== ''
    && Number.isInteger(replicaCount) && replicaCount >= 0 && replicaCount <= 1000;

  const run = async (
    fn: () => Promise<unknown>, okKey: string, okTarget: string, after: () => void = onDone,
  ) => {
    setBusy(true);
    try {
      await fn();
      showSuccess(t(okKey, { target: okTarget }));
      after();
    } catch (err) {
      showError(errorMessage(err, t('kube.actions.failed')));
    } finally {
      setBusy(false);
    }
  };

  const canScale = SCALABLE.includes(kind) && Boolean(ns);
  const canRestart = RESTARTABLE.includes(kind) && Boolean(ns);
  const canDelete = DELETABLE.includes(kind) && Boolean(ns);
  // Ohne geladenes Objekt ist der Cordon-Zustand unbekannt — dann gar kein
  // Knopf statt eines „Sperren" für eine bereits gesperrte Node.
  const nodeCordoned = kind === 'Node' ? unschedulableOf(object) : undefined;
  const isNode = nodeCordoned !== undefined;
  const nodeTarget = `${cluster.label} · ${row.name}`;
  if (!canScale && !canRestart && !canDelete && !isNode) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
      {canScale && ns && (
        <>
          <label className="flex items-center gap-1 text-xs text-slate-300">
            {t('kube.actions.replicas')}
            <input
              type="number" min={0} max={1000} step={1} value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              className="w-16 rounded-sm border border-slate-700 bg-slate-900 p-1 text-xs"
            />
          </label>
          <ConfirmButton
            variant="danger" confirmVariant="danger-solid" size="xs"
            disabled={busy || !replicasValid}
            label={t('kube.actions.scale')}
            confirmLabel={t('kube.actions.scaleConfirm', { target, replicas })}
            onConfirm={() => run(
              () => api.scaleKubeResource(cluster._id, {
                kind, name: row.name, namespace: ns, replicas: replicaCount,
              }), 'kube.actions.scaleOk', target)}
          />
          {!replicasValid && (
            <span className="text-xs text-amber-300">{t('kube.actions.scaleInvalid')}</span>
          )}
        </>
      )}

      {canRestart && ns && (
        <ConfirmButton
          variant="danger" confirmVariant="danger-solid" size="xs" disabled={busy}
          label={t('kube.actions.restart')}
          confirmLabel={t('kube.actions.restartConfirm', { target })}
          onConfirm={() => run(
            () => api.restartKubeResource(cluster._id, { kind, name: row.name, namespace: ns }),
            'kube.actions.restartOk', target)}
        />
      )}

      {canDelete && ns && (
        <ConfirmButton
          variant="danger" confirmVariant="danger-solid" size="xs" disabled={busy}
          label={t('kube.actions.delete')}
          confirmLabel={t('kube.actions.deleteConfirm', { target })}
          onConfirm={() => run(
            () => api.deleteKubeResource(cluster._id, { kind, name: row.name, namespace: ns }),
            'kube.actions.deleteOk', target, onDeleted ?? onDone)}
        />
      )}

      {isNode && !nodeCordoned && (
        <ConfirmButton
          variant="danger" confirmVariant="danger-solid" size="xs" disabled={busy}
          label={t('kube.actions.cordon')}
          confirmLabel={t('kube.actions.cordonConfirm', { target: nodeTarget })}
          onConfirm={() => run(
            () => api.cordonKubeNode(cluster._id, { node: row.name, unschedulable: true }),
            'kube.actions.cordonOk', nodeTarget)}
        />
      )}

      {isNode && nodeCordoned && (
        <>
          <span className="text-xs text-amber-300">{t('kube.actions.cordoned')}</span>
          <ConfirmButton
            variant="danger" confirmVariant="danger-solid" size="xs" disabled={busy}
            label={t('kube.actions.uncordon')}
            confirmLabel={t('kube.actions.uncordonConfirm', { target: nodeTarget })}
            onConfirm={() => run(
              () => api.cordonKubeNode(cluster._id, { node: row.name, unschedulable: false }),
              'kube.actions.uncordonOk', nodeTarget)}
          />
        </>
      )}
    </div>
  );
}
