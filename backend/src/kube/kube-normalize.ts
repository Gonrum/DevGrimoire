import { dumpYaml } from '@kubernetes/client-node';
import { isRecord } from '../common/narrow';

/** Zeile einer Ressourcenliste — schmal gehalten, das Detail holt `get`. */
export interface KubeListRow {
  name: string;
  namespace?: string;
  createdAt?: string;
  status?: string;
  ready?: string;
  restarts?: number;
  node?: string;
  detail?: string;
}

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
const ANNOTATION_MAX = 256;

/**
 * Entfernt, was ein Cluster-Objekt aufbläht, ohne Aussagewert zu haben:
 * `managedFields` und die last-applied-Annotation. Lange Annotations werden
 * gekürzt. Arbeitet auf einer flachen Kopie — das Eingabeobjekt bleibt
 * unangetastet, weil Aufrufer es weiterverwenden.
 *
 * Signatur bewusst `unknown -> unknown` statt generisch `<T>(obj: T): T`:
 * ein Nicht-Objekt (oder ein Objekt ohne `metadata`) kommt unverändert
 * zurück, ein Objekt mit `metadata` als neu zusammengesetztes Literal. Beides
 * lässt sich ohne Assertion in `unknown` zurückgeben — Aufrufer, die eine
 * konkrete Form brauchen, verengen selbst (z.B. mit `isRecord`).
 */
export function stripHeavyMetadata(obj: unknown): unknown {
  if (!isRecord(obj)) return obj;
  const meta = obj.metadata;
  if (!isRecord(meta)) return obj;

  const nextMeta: Record<string, unknown> = { ...meta };
  delete nextMeta.managedFields;

  if (isRecord(meta.annotations)) {
    const annotations: Record<string, string> = {};
    for (const [key, value] of Object.entries(meta.annotations)) {
      if (key === LAST_APPLIED) continue;
      const text = typeof value === 'string' ? value : String(value);
      annotations[key] =
        text.length > ANNOTATION_MAX ? `${text.slice(0, ANNOTATION_MAX)}… (gekürzt)` : text;
    }
    nextMeta.annotations = annotations;
  }

  return { ...obj, metadata: nextMeta };
}

function readString(source: unknown, ...pathSegments: string[]): string | undefined {
  let cursor: unknown = source;
  for (const segment of pathSegments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function readNumber(source: unknown, ...pathSegments: string[]): number | undefined {
  let cursor: unknown = source;
  for (const segment of pathSegments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return typeof cursor === 'number' ? cursor : undefined;
}

function podReadiness(obj: unknown): { ready: string; restarts: number } {
  const statuses = isRecord(obj) && isRecord(obj.status) ? obj.status.containerStatuses : undefined;
  if (!Array.isArray(statuses)) return { ready: '0/0', restarts: 0 };
  let ready = 0;
  let restarts = 0;
  for (const entry of statuses) {
    if (!isRecord(entry)) continue;
    if (entry.ready === true) ready += 1;
    if (typeof entry.restartCount === 'number') restarts += entry.restartCount;
  }
  return { ready: `${ready}/${statuses.length}`, restarts };
}

/**
 * Projiziert ein Cluster-Objekt auf die Zeile, die Liste und MCP sehen.
 * Unbekannte Kinds fallen auf Name/Namespace zurück statt zu werfen — eine
 * Liste soll nicht daran scheitern, dass ein Objekt eine Form hat, die hier
 * noch niemand vorgesehen hat.
 */
export function projectRow(kind: string, obj: unknown): KubeListRow {
  const base: KubeListRow = {
    name: readString(obj, 'metadata', 'name') ?? '(ohne Namen)',
    namespace: readString(obj, 'metadata', 'namespace'),
    createdAt: readString(obj, 'metadata', 'creationTimestamp'),
  };

  switch (kind) {
    case 'Pod': {
      const { ready, restarts } = podReadiness(obj);
      return {
        ...base,
        status: readString(obj, 'status', 'phase'),
        ready,
        restarts,
        node: readString(obj, 'spec', 'nodeName'),
      };
    }
    case 'Deployment':
    case 'StatefulSet': {
      const total = readNumber(obj, 'status', 'replicas') ?? 0;
      const ready = readNumber(obj, 'status', 'readyReplicas') ?? 0;
      return { ...base, ready: `${ready}/${total}` };
    }
    case 'DaemonSet': {
      const desired = readNumber(obj, 'status', 'desiredNumberScheduled') ?? 0;
      const ready = readNumber(obj, 'status', 'numberReady') ?? 0;
      return { ...base, ready: `${ready}/${desired}` };
    }
    case 'Job': {
      const succeeded = readNumber(obj, 'status', 'succeeded') ?? 0;
      const wanted = readNumber(obj, 'spec', 'completions') ?? 1;
      return { ...base, ready: `${succeeded}/${wanted}` };
    }
    case 'CronJob':
      return { ...base, detail: readString(obj, 'spec', 'schedule') };
    case 'Service':
      return { ...base, detail: readString(obj, 'spec', 'clusterIP'), status: readString(obj, 'spec', 'type') };
    case 'Node': {
      const conditions = isRecord(obj) && isRecord(obj.status) ? obj.status.conditions : undefined;
      let statusText = 'Unknown';
      if (Array.isArray(conditions)) {
        for (const c of conditions) {
          if (isRecord(c) && c.type === 'Ready') statusText = c.status === 'True' ? 'Ready' : 'NotReady';
        }
      }
      return { ...base, status: statusText };
    }
    case 'PersistentVolumeClaim':
      return { ...base, status: readString(obj, 'status', 'phase') };
    case 'Namespace':
      return { ...base, status: readString(obj, 'status', 'phase') };
    default:
      return base;
  }
}

/**
 * Ersetzt die Werte eines Secrets durch die blosse Liste seiner Schlüssel.
 * Das ist eine Sicherheitsgrenze, keine Anzeigeoptimierung: das Modul soll
 * kein Umweg um das Cluster-RBAC sein, dem der Nutzer gerade vertraut.
 *
 * Signatur bewusst `unknown -> Record<string, unknown> & { keys: string[] }`
 * statt generisch `<T>(obj: T): T & { keys: string[] }`: das Ergebnis wird
 * als Objekt-Literal zusammengesetzt, dessen Form TypeScript strukturell
 * gegen den Rückgabetyp prüfen kann — ganz ohne Assertion.
 */
export function redactSecret(obj: unknown): Record<string, unknown> & { keys: string[] } {
  const keySet = new Set<string>();
  if (isRecord(obj)) {
    if (isRecord(obj.data)) for (const k of Object.keys(obj.data)) keySet.add(k);
    if (isRecord(obj.stringData)) for (const k of Object.keys(obj.stringData)) keySet.add(k);
  }
  const base: Record<string, unknown> = isRecord(obj) ? { ...obj } : {};
  delete base.data;
  delete base.stringData;
  return { ...base, keys: [...keySet] };
}

/**
 * YAML-Ausgabe fürs Detail — immer über die Strip-Schicht.
 *
 * Zusätzliches Sicherheitsnetz: trägt das Objekt `kind: 'Secret'`, läuft es
 * vor `dumpYaml` zusätzlich durch `redactSecret`. Das ist Best-Effort, kein
 * Ersatz für kind-bewusste Aufrufer-Logik: `dumpYaml` bestimmt seinen
 * Serialisierungspfad selbst über `apiVersion`/`kind` des übergebenen
 * Objekts (`ObjectSerializer` in `@kubernetes/client-node`) — fehlen beide
 * (z.B. bei `items[]` aus einer List-Antwort, die typischerweise kein
 * eigenes `kind` tragen, oder bei einem unvollständigen/kaputten Objekt),
 * greift dort ein generischer Pfad, der *alle* Felder unverändert
 * durchreicht, inklusive `data`/`stringData`. Aufrufer, die den Kind schon
 * kennen (z.B. aus der Listen-Anfrage), müssen ein Secret deshalb weiterhin
 * *selbst* vor dem Aufruf durch `redactSecret` schicken — dieser Fall fängt
 * nur nach, was sonst durchrutschen würde, wenn `kind` zufällig vorhanden
 * ist.
 *
 * `dumpYaml` selbst wirft bei `null`/`undefined` (liest `.apiVersion` davon),
 * degradiert bei jedem anderen Wert. Das wird hier abgefangen, damit die
 * Funktion ihrem eigenen Namen treu bleibt — „sicher", nicht „sicher, außer
 * bei kaputter Eingabe".
 */
export function toYamlSafe(obj: unknown): string {
  const stripped = stripHeavyMetadata(obj);
  const safe = isRecord(stripped) && stripped.kind === 'Secret' ? redactSecret(stripped) : stripped;
  return dumpYaml(safe ?? {});
}
