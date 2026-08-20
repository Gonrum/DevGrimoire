export interface KubeKindGroup {
  labelKey: string;
  kinds: string[];
}

/** Der Ressourcen-Baum links. Reihenfolge ist Absicht: Workloads zuerst. */
export const KUBE_KIND_GROUPS: KubeKindGroup[] = [
  { labelKey: 'kube.group.workloads', kinds: ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] },
  { labelKey: 'kube.group.network', kinds: ['Service', 'Ingress'] },
  { labelKey: 'kube.group.config', kinds: ['ConfigMap', 'Secret'] },
  { labelKey: 'kube.group.storage', kinds: ['PersistentVolumeClaim'] },
  { labelKey: 'kube.group.cluster', kinds: ['Namespace', 'Node', 'Event'] },
];

/**
 * Poll-Intervalle laut Spec: Events 3 s, Pods 5 s, alles übrige 10 s.
 * Gepollt wird nur die sichtbare Liste — der Aufrufer schaltet über `active`.
 */
export function pollIntervalFor(kind: string): number {
  if (kind === 'Event') return 3000;
  if (kind === 'Pod') return 5000;
  return 10000;
}

/** Welche Spalten eine Tabelle je Kind zeigt. Feste Liste, keine Ableitung. */
export function columnsFor(kind: string): Array<'namespace' | 'status' | 'ready' | 'restarts' | 'node' | 'detail' | 'age'> {
  switch (kind) {
    case 'Pod': return ['namespace', 'status', 'ready', 'restarts', 'node', 'age'];
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'Job': return ['namespace', 'ready', 'age'];
    case 'CronJob': return ['namespace', 'detail', 'age'];
    case 'Service': return ['namespace', 'status', 'detail', 'age'];
    case 'Node': return ['status', 'age'];
    case 'Namespace': return ['status', 'age'];
    case 'PersistentVolumeClaim': return ['namespace', 'status', 'age'];
    default: return ['namespace', 'age'];
  }
}

/**
 * Feste Klassen-Map für die Statuszelle — dieselbe Begründung wie
 * `kubeStatus.ts`: eine zusammengesetzte Klasse (`bg-${x}-500`) überlebt den
 * Tailwind-Purge nicht. Deckt die Statuswerte ab, die `kube-normalize.ts`
 * (Backend) tatsächlich liefert: Pod-/PVC-/Namespace-Phase, Node-Readiness.
 * Alles Unbekannte (z.B. der Service-`spec.type`, der dasselbe Feld
 * zweckentfremdet) bleibt neutral statt geraten eingefärbt zu werden.
 */
const STATUS_CLASSES: Record<string, string> = {
  Running: 'text-emerald-300',
  Ready: 'text-emerald-300',
  Active: 'text-emerald-300',
  Bound: 'text-emerald-300',
  Succeeded: 'text-emerald-300',
  Pending: 'text-amber-300',
  Terminating: 'text-amber-300',
  Unknown: 'text-amber-300',
  Failed: 'text-red-300',
  NotReady: 'text-red-300',
  Lost: 'text-red-300',
};

export function statusClasses(status?: string): string {
  if (status === undefined) return 'text-gray-300';
  return STATUS_CLASSES[status] ?? 'text-gray-300';
}
