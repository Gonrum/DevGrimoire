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
  /** Nur für `Event`: die Meldung selbst, auf Zeilenlänge gekürzt. */
  message?: string;
}

/** Kürzungsgrenze für `KubeListRow.message` — eine Tabellenzelle, kein Log. */
const ROW_MESSAGE_MAX = 300;

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

/**
 * Ein Textfeld aus einer Cluster-Antwort lesen — inklusive der Zeitfelder.
 *
 * `@kubernetes/client-node` liefert **keine** Strings für Zeitstempel: sein
 * `ObjectSerializer` deserialisiert jedes Feld, das die generierten Modelle als
 * `Date` deklarieren, über `new Date(data)` (`dist/gen/models/
 * ObjectSerializer.js`, Zweig `type === "Date"`). Betroffen sind
 * `metadata.creationTimestamp`, `Event.lastTimestamp`/`firstTimestamp` und
 * jedes `condition.lastTransitionTime`.
 *
 * Ein blosses `typeof v === 'string'` verwirft die deshalb **alle** —
 * lautlos, weil `undefined` in einem optionalen Feld wie ein Objekt aussieht,
 * das das Feld eben nicht hat. Real gemessen: `createdAt` fehlte in JEDER
 * Listenzeile, `lastTimestamp` in 97 von 105 Events (die 8 Überlebenden kamen
 * über `eventTime`, weil `V1MicroTime` kein `Date` ist).
 *
 * Die Umwandlung sitzt bewusst hier unten an EINER Stelle statt an jeder
 * Lesestelle: `readString` und der `str`-Helfer in `kube-resources.service.ts`
 * teilen sie sich, sonst driftet die nächste Kopie wieder auseinander.
 *
 * `Number.isNaN(getTime())` ist kein Zierrat: `new Date('kaputt')` ist ein
 * gültiges `Date`, dessen `toISOString()` mit `RangeError` wirft — ohne den
 * Guard nähme ein einziges kaputtes Feld die ganze Liste mit.
 */
export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return undefined;
}

function readString(source: unknown, ...pathSegments: string[]): string | undefined {
  let cursor: unknown = source;
  for (const segment of pathSegments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return asString(cursor);
}

function readNumber(source: unknown, ...pathSegments: string[]): number | undefined {
  let cursor: unknown = source;
  for (const segment of pathSegments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return typeof cursor === 'number' ? cursor : undefined;
}

/**
 * `string[]` — Prädikat statt Assertion, damit `redactSecret` ein bereits
 * redigiertes `keys` übernehmen darf, ohne es zu behaupten. Ein gemischtes
 * Array (`['a', 42]`) ist kein `string[]` und wird verworfen, nicht gefiltert:
 * halb übernommene Schlüsselnamen wären irreführender als gar keine.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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
    case 'Event': {
      // `Event` steht laut Spec in der Cluster-Gruppe des Baums, hatte hier
      // aber kein `case` und fiel auf `default` — die Liste zeigte generierte
      // Namen wie „api.18cdbed60501a8b3" und sonst nichts. `type` in `status`
      // (damit `Warning` sich abhebt), `reason` als Detail, die Meldung
      // gekürzt daneben.
      const message = readString(obj, 'message');
      return {
        ...base,
        status: readString(obj, 'type'),
        detail: readString(obj, 'reason'),
        message: message !== undefined && message.length > ROW_MESSAGE_MAX
          ? `${message.slice(0, ROW_MESSAGE_MAX)}…`
          : message,
      };
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
 *
 * **Idempotent** (Review-Fund B): sind weder `data` noch `stringData` da,
 * aber ein `keys: string[]` aus einem früheren Lauf, wird das übernommen
 * statt durch `[]` ersetzt. Ohne das verlor die Komposition
 * `getYaml -> get -> redactSecret` + `toYamlSafe -> redactSecret` die
 * Schlüsselnamen: der zweite Lauf fand nichts mehr, `keys` wurde leer, und
 * `withRedactedKeysAnnotation` stieg bei leerer Liste aus — das YAML eines
 * redigierten Secrets sah aus wie das eines Secrets ganz OHNE Daten. Kein
 * Leck (kein Wert entkommt auf beiden Wegen), aber genau die Transparenz,
 * für die diese Funktion existiert.
 *
 * Die Übernahme greift bewusst NUR, wenn es nichts zu redigieren gibt: läge
 * `data` vor, dürfte ein mitgeliefertes `keys`-Feld die echten Schlüsselnamen
 * nicht überstimmen.
 */
export function redactSecret(obj: unknown): Record<string, unknown> & { keys: string[] } {
  const keySet = new Set<string>();
  let hadSource = false;
  if (isRecord(obj)) {
    if (isRecord(obj.data)) {
      hadSource = true;
      for (const k of Object.keys(obj.data)) keySet.add(k);
    }
    if (isRecord(obj.stringData)) {
      hadSource = true;
      for (const k of Object.keys(obj.stringData)) keySet.add(k);
    }
    if (!hadSource && isStringArray(obj.keys)) for (const k of obj.keys) keySet.add(k);
  }
  const base: Record<string, unknown> = isRecord(obj) ? { ...obj } : {};
  delete base.data;
  delete base.stringData;
  return { ...base, keys: [...keySet] };
}

const REDACTED_KEYS_ANNOTATION = 'devgrimoire.io/redacted-keys';

/**
 * `dumpYaml` serialisiert ein erkanntes Kind (hier `V1Secret`) strikt gegen
 * dessen deklarierte Feldliste (`apiVersion, data, immutable, kind,
 * metadata, stringData, type`) — ein zusätzliches Top-Level-Feld wie `keys`
 * aus `redactSecret` gehört nicht dazu und wird beim Dump kommentarlos
 * verworfen. Ohne Gegenmaßnahme sieht das YAML eines redigierten Secrets
 * dann genauso aus wie das eines Secrets ganz ohne Daten — genau die
 * Transparenz, für die `redactSecret` existiert, geht auf diesem Weg
 * verloren.
 *
 * Die Schlüsselnamen wandern deshalb in eine Annotation:
 * `metadata.annotations` ist bei `V1ObjectMeta` selbst ein deklariertes,
 * freies String-Feld (`{ [key: string]: string }`) und übersteht die
 * Serialisierung unverändert. Das ist kein erfundenes API-Feld, sondern der
 * von Kubernetes vorgesehene Mechanismus für genau diesen Zweck — derselbe,
 * über den z.B. `kubectl.kubernetes.io/last-applied-configuration`
 * funktioniert (nur mit unserem Namespace statt kubectls).
 */
function withRedactedKeysAnnotation(
  redacted: Record<string, unknown> & { keys: string[] },
): Record<string, unknown> {
  if (redacted.keys.length === 0) return redacted;
  const meta = isRecord(redacted.metadata) ? redacted.metadata : {};
  const annotations = isRecord(meta.annotations) ? meta.annotations : {};
  return {
    ...redacted,
    metadata: {
      ...meta,
      annotations: {
        ...annotations,
        [REDACTED_KEYS_ANNOTATION]: [...redacted.keys].sort().join(','),
      },
    },
  };
}

/**
 * YAML-Ausgabe fürs Detail — immer über die Strip-Schicht.
 *
 * Zusätzliches Sicherheitsnetz: trägt das Objekt `kind: 'Secret'`, läuft es
 * vor `dumpYaml` zusätzlich durch `redactSecret` (und danach durch
 * `withRedactedKeysAnnotation`, damit die Schlüsselnamen im YAML sichtbar
 * bleiben — siehe dort). Das ist Best-Effort, kein Ersatz für kind-bewusste
 * Aufrufer-Logik: `dumpYaml` bestimmt seinen Serialisierungspfad selbst über
 * `apiVersion`/`kind` des übergebenen Objekts (`ObjectSerializer` in
 * `@kubernetes/client-node`) — fehlen beide (z.B. bei `items[]` aus einer
 * List-Antwort, die typischerweise kein eigenes `kind` tragen, oder bei
 * einem unvollständigen/kaputten Objekt), greift dort ein generischer Pfad,
 * der *alle* Felder unverändert durchreicht, inklusive `data`/`stringData`.
 * Aufrufer, die den Kind schon kennen (z.B. aus der Listen-Anfrage), müssen
 * ein Secret deshalb weiterhin *selbst* vor dem Aufruf durch `redactSecret`
 * schicken — dieser Fall fängt nur nach, was sonst durchrutschen würde, wenn
 * `kind` zufällig vorhanden ist.
 *
 * `dumpYaml` selbst wirft bei `null`/`undefined` (liest `.apiVersion` davon),
 * degradiert bei jedem anderen Wert. Das wird hier abgefangen, damit die
 * Funktion ihrem eigenen Namen treu bleibt — „sicher", nicht „sicher, außer
 * bei kaputter Eingabe".
 */
export function toYamlSafe(obj: unknown): string {
  // Die Reihenfolge ist tragend, nicht Geschmack: `stripHeavyMetadata` MUSS
  // vor `redactSecret` laufen. Es entfernt die Annotation
  // `kubectl.kubernetes.io/last-applied-configuration`, und die trägt bei
  // einem per `kubectl apply` erzeugten Secret das vollständige
  // base64-`data` als JSON-Text mit sich. `redactSecret` schaut nur auf die
  // Felder `data`/`stringData` — umgekehrt aufgerufen bliebe der Wert also
  // in der Annotation stehen und wäre im YAML sichtbar, obwohl das Secret
  // formal redigiert wäre. Dieselbe Reihenfolge gilt in
  // `KubeResourcesService.get()`/`describe()`.
  const stripped = stripHeavyMetadata(obj);
  const safe =
    isRecord(stripped) && stripped.kind === 'Secret'
      ? withRedactedKeysAnnotation(redactSecret(stripped))
      : stripped;
  return dumpYaml(safe ?? {});
}
