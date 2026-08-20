export type KubeKind =
  | 'Namespace' | 'Node' | 'Pod' | 'Deployment' | 'StatefulSet' | 'DaemonSet'
  | 'Job' | 'CronJob' | 'Service' | 'Ingress' | 'ConfigMap' | 'Secret'
  | 'PersistentVolumeClaim' | 'Event';

/** Welche API-Klasse ein Kind bedient. */
export type KubeApiGroup = 'core' | 'apps' | 'batch' | 'networking';

export interface KubeKindSpec {
  group: KubeApiGroup;
  namespaced: boolean;
  /** Methodenname für „in einem Namespace listen". */
  listNamespaced?: string;
  /** Methodenname für „über alle Namespaces listen". */
  listAll: string;
  /** Methodenname für „ein Objekt lesen". */
  read: string;
}

/**
 * Methodennamen gegen `node_modules/@kubernetes/client-node/dist/gen/types/
 * ObjectParamAPI.d.ts` verifiziert (2.0.0) — jede hier verwendete Methode
 * kommt dort genau einmal als `<name>(param` in der jeweiligen API-Klasse vor
 * (Event-Methoden erscheinen zweimal, weil sie sowohl CoreV1Api als auch
 * EventsV1Api deklarieren — hier wird die CoreV1Api-Variante genutzt).
 */
export const KUBE_KIND_SPECS: Readonly<Record<KubeKind, KubeKindSpec>> = {
  Namespace: { group: 'core', namespaced: false, listAll: 'listNamespace', read: 'readNamespace' },
  Node: { group: 'core', namespaced: false, listAll: 'listNode', read: 'readNode' },
  Pod: { group: 'core', namespaced: true, listNamespaced: 'listNamespacedPod', listAll: 'listPodForAllNamespaces', read: 'readNamespacedPod' },
  Service: { group: 'core', namespaced: true, listNamespaced: 'listNamespacedService', listAll: 'listServiceForAllNamespaces', read: 'readNamespacedService' },
  ConfigMap: { group: 'core', namespaced: true, listNamespaced: 'listNamespacedConfigMap', listAll: 'listConfigMapForAllNamespaces', read: 'readNamespacedConfigMap' },
  Secret: { group: 'core', namespaced: true, listNamespaced: 'listNamespacedSecret', listAll: 'listSecretForAllNamespaces', read: 'readNamespacedSecret' },
  PersistentVolumeClaim: { group: 'core', namespaced: true, listNamespaced: 'listNamespacedPersistentVolumeClaim', listAll: 'listPersistentVolumeClaimForAllNamespaces', read: 'readNamespacedPersistentVolumeClaim' },
  Event: { group: 'core', namespaced: true, listNamespaced: 'listNamespacedEvent', listAll: 'listEventForAllNamespaces', read: 'readNamespacedEvent' },
  Deployment: { group: 'apps', namespaced: true, listNamespaced: 'listNamespacedDeployment', listAll: 'listDeploymentForAllNamespaces', read: 'readNamespacedDeployment' },
  StatefulSet: { group: 'apps', namespaced: true, listNamespaced: 'listNamespacedStatefulSet', listAll: 'listStatefulSetForAllNamespaces', read: 'readNamespacedStatefulSet' },
  DaemonSet: { group: 'apps', namespaced: true, listNamespaced: 'listNamespacedDaemonSet', listAll: 'listDaemonSetForAllNamespaces', read: 'readNamespacedDaemonSet' },
  Job: { group: 'batch', namespaced: true, listNamespaced: 'listNamespacedJob', listAll: 'listJobForAllNamespaces', read: 'readNamespacedJob' },
  CronJob: { group: 'batch', namespaced: true, listNamespaced: 'listNamespacedCronJob', listAll: 'listCronJobForAllNamespaces', read: 'readNamespacedCronJob' },
  Ingress: { group: 'networking', namespaced: true, listNamespaced: 'listNamespacedIngress', listAll: 'listIngressForAllNamespaces', read: 'readNamespacedIngress' },
};

// Nicht aus `Object.keys(KUBE_KIND_SPECS)` abgeleitet: das liefert nur
// `string[]`, ein Cast auf `KubeKind[]` wäre eine unbewiesene Behauptung
// (genau das Muster, das `no-unsafe-type-assertion` fängt). Ausgeschrieben
// prüft der Compiler stattdessen jedes einzelne Literal gegen `KubeKind`.
export const KUBE_KINDS: readonly KubeKind[] = [
  'Namespace', 'Node', 'Pod', 'Deployment', 'StatefulSet', 'DaemonSet',
  'Job', 'CronJob', 'Service', 'Ingress', 'ConfigMap', 'Secret',
  'PersistentVolumeClaim', 'Event',
];

export function isKubeKind(value: unknown): value is KubeKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KUBE_KIND_SPECS, value);
}

export function isNamespaced(kind: KubeKind): boolean {
  return KUBE_KIND_SPECS[kind].namespaced;
}
