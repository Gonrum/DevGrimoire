import {
  AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig, NetworkingV1Api,
} from '@kubernetes/client-node';
import { BadRequestException, Injectable } from '@nestjs/common';
import { KubeClustersService } from './kube-clusters.service';
import { KubeClientService } from './kube-client.service';
import {
  isKubeKind, isNamespaced, KubeApiGroup, KUBE_KIND_SPECS, KubeKind,
} from './kube-kinds';
import {
  asString, KubeListRow, projectRow, redactSecret, stripHeavyMetadata, toYamlSafe,
} from './kube-normalize';
import { isRecord } from '../common/narrow';

const LIMIT_MAX = 500;
const LIMIT_DEFAULT = 200;

export interface KubeListOptions {
  namespace?: string;
  labelSelector?: string;
  limit?: number;
}

export interface KubeEventRow {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  involvedKind?: string;
  involvedName?: string;
  namespace?: string;
}

export interface KubeCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface KubeDescribeResult {
  object: unknown;
  events: KubeEventRow[];
  conditions: KubeCondition[];
}

/**
 * Wie `isNullaryMethod` in `common/narrow.ts`, nur mit einem Parameter: jede
 * Ressourcen-Methode des generierten Clients (`listNamespacedPod`,
 * `readNamespacedSecret`, …) nimmt genau ein Param-Objekt und liefert ein
 * Promise. Ein blankes `typeof value === 'function'` würde nur zu `Function`
 * verengen, dessen `.call()` wieder `any` liefert und die
 * `no-unsafe-*`-Familie zurückholt — dieses Prädikat sagt stattdessen das
 * Schwächste, worauf sich `callApi` unten tatsächlich verlässt.
 */
function isApiMethod(
  value: unknown,
): value is (param: Record<string, unknown>) => Promise<unknown> {
  return typeof value === 'function';
}

@Injectable()
export class KubeResourcesService {
  constructor(
    private readonly clusters: KubeClustersService,
    private readonly client: KubeClientService,
  ) {}

  /**
   * Liefert den generierten API-Client für eine Gruppe. Als `switch` statt
   * über eine `Record<KubeApiGroup, ApiConstructor>`-Tabelle: `makeApiClient`
   * ist generisch über die konkrete Klasse (`ApiConstructor<T>`), ein Zugriff
   * über einen zusammengesetzten Union-Typ lässt sich dagegen nicht mehr auf
   * ein einzelnes `T` auflösen (TS2345 — die vier generierten Klassen teilen
   * keine gemeinsame Konstruktorsignatur). Jeder `case` ruft `makeApiClient`
   * dagegen mit einer konkret bekannten Klasse auf; das Ergebnis auf `unknown`
   * zu verbreitern ist danach keine Behauptung mehr, sondern eine Erweiterung.
   */
  private apiFor(kc: KubeConfig, group: KubeApiGroup): unknown {
    switch (group) {
      case 'core': return kc.makeApiClient(CoreV1Api);
      case 'apps': return kc.makeApiClient(AppsV1Api);
      case 'batch': return kc.makeApiClient(BatchV1Api);
      case 'networking': return kc.makeApiClient(NetworkingV1Api);
      default: throw new BadRequestException(`Unbekannte API-Gruppe "${String(group)}"`);
    }
  }

  /**
   * Führt `fn` mit einer aufgelösten KubeConfig aus und gibt den Transport
   * danach frei — auf JEDEM Pfad. Der Refcount aus K1 hängt daran: ohne
   * Freigabe bleiben eine SSH-Verbindung und ein TCP-Listener bis zum
   * Prozessende offen. Alle Cluster-Zugriffe dieses Service laufen hier
   * durch; keiner ruft `buildConfig` direkt.
   */
  private async withConfig<T>(
    clusterId: string,
    fn: (api: (group: KubeApiGroup) => unknown) => Promise<T>,
  ): Promise<T> {
    const cluster = await this.clusters.findById(clusterId);
    const { kc, release } = await this.client.buildConfig(cluster);
    try {
      return await fn((group) => this.apiFor(kc, group));
    } finally {
      release();
    }
  }

  private assertKind(kind: string): KubeKind {
    if (!isKubeKind(kind)) {
      throw new BadRequestException(`Unbekannter Ressourcentyp "${kind}"`);
    }
    return kind;
  }

  private clampLimit(limit?: number): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return LIMIT_DEFAULT;
    return Math.min(Math.trunc(limit), LIMIT_MAX);
  }

  /**
   * Ruft eine Methode am generierten Client auf. Die Registry hält
   * Methodennamen als Strings, deshalb wird hier geprüft statt behauptet:
   * ein Tippfehler in der Registry soll eine klare Meldung geben und nicht
   * `undefined is not a function`.
   */
  private async callApi(client: unknown, method: string, param: Record<string, unknown>): Promise<unknown> {
    if (!isRecord(client)) {
      throw new BadRequestException(`Cluster-API kennt "${method}" nicht`);
    }
    // Zwei Prädikate statt einer Behauptung: `isRecord` erlaubt den
    // Feldzugriff, `isApiMethod` die Verengung auf einen aufrufbaren Typ.
    // `this` muss dabei explizit auf `client` gebunden bleiben — die
    // generierten Methoden lesen intern `this.api...` (ObjectParamAPI.js),
    // ein entkoppeltes `fn(param)` würde daran mit einem `this`-Fehler
    // scheitern.
    const fn = client[method];
    if (!isApiMethod(fn)) {
      throw new BadRequestException(`Cluster-API kennt "${method}" nicht`);
    }
    return fn.call(client, param);
  }

  async listNamespaces(clusterId: string): Promise<KubeListRow[]> {
    return this.list(clusterId, 'Namespace', {});
  }

  async list(clusterId: string, kindInput: string, opts: KubeListOptions): Promise<KubeListRow[]> {
    const kind = this.assertKind(kindInput);
    const spec = KUBE_KIND_SPECS[kind];
    const limit = this.clampLimit(opts.limit);

    return this.withConfig(clusterId, async (api) => {
      const client = api(spec.group);
      const useNamespaced = Boolean(opts.namespace) && isNamespaced(kind) && Boolean(spec.listNamespaced);
      const method = useNamespaced && spec.listNamespaced ? spec.listNamespaced : spec.listAll;
      const param: Record<string, unknown> = { limit };
      if (useNamespaced) param.namespace = opts.namespace;
      if (opts.labelSelector) param.labelSelector = opts.labelSelector;

      const result = await this.callApi(client, method, param);
      const items = isRecord(result) && Array.isArray(result.items) ? result.items : [];
      return items.map((item) => projectRow(kind, item));
    });
  }

  async get(clusterId: string, kindInput: string, name: string, namespace?: string): Promise<unknown> {
    const kind = this.assertKind(kindInput);
    const spec = KUBE_KIND_SPECS[kind];
    if (isNamespaced(kind) && !namespace) {
      throw new BadRequestException(`${kind} braucht einen Namespace`);
    }

    return this.withConfig(clusterId, async (api) => {
      const client = api(spec.group);
      const param: Record<string, unknown> = { name };
      if (isNamespaced(kind)) param.namespace = namespace;
      const raw = await this.callApi(client, spec.read, param);
      const stripped = stripHeavyMetadata(raw);
      // Secrets verlieren ihre Werte, bevor irgendetwas sie sieht — und
      // zwar weil der ANGEFRAGTE Kind 'Secret' ist, nicht weil das
      // zurückgegebene Objekt selbst `kind: 'Secret'` trägt. Ein Objekt aus
      // einer List-Antwort hat typischerweise kein eigenes `kind`/
      // `apiVersion` (siehe toYamlSafe-JSDoc in kube-normalize.ts); ein Guard,
      // der auf `raw.kind` schaut, würde das durchlassen. Hier gibt es diesen
      // Fall nicht: `get()` liest immer per `readNamespaced<Kind>`, nie aus
      // einer Liste — aber genau deshalb darf sich dieser Pfad nicht auf das
      // Feld des Objekts verlassen, sondern nur auf den Parameter, den der
      // Aufrufer explizit angefragt hat.
      return kind === 'Secret' ? redactSecret(stripped) : stripped;
    });
  }

  async getYaml(clusterId: string, kindInput: string, name: string, namespace?: string): Promise<string> {
    const obj = await this.get(clusterId, kindInput, name, namespace);
    return toYamlSafe(obj);
  }

  private projectEvent(raw: unknown): KubeEventRow {
    const involved = isRecord(raw) && isRecord(raw.involvedObject) ? raw.involvedObject : undefined;
    // `asString` statt eines lokalen `typeof v === 'string'`: der Cluster
    // liefert `lastTimestamp` als `Date`, nicht als String (siehe JSDoc dort).
    const str = asString;
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    return {
      type: isRecord(raw) ? str(raw.type) : undefined,
      reason: isRecord(raw) ? str(raw.reason) : undefined,
      message: isRecord(raw) ? str(raw.message)?.slice(0, 1000) : undefined,
      count: isRecord(raw) ? num(raw.count) : undefined,
      lastTimestamp: isRecord(raw) ? str(raw.lastTimestamp) ?? str(raw.eventTime) : undefined,
      involvedKind: involved ? str(involved.kind) : undefined,
      involvedName: involved ? str(involved.name) : undefined,
      namespace: isRecord(raw) && isRecord(raw.metadata) ? str(raw.metadata.namespace) : undefined,
    };
  }

  /** Neueste zuerst. Ereignisse ohne Zeitstempel sinken ans Ende. */
  private sortEvents(rows: KubeEventRow[]): KubeEventRow[] {
    return [...rows].sort((a, b) => {
      const at = a.lastTimestamp ? Date.parse(a.lastTimestamp) : 0;
      const bt = b.lastTimestamp ? Date.parse(b.lastTimestamp) : 0;
      return bt - at;
    });
  }

  async events(
    clusterId: string,
    opts: { namespace?: string; involvedName?: string; limit?: number },
  ): Promise<KubeEventRow[]> {
    const rows = await this.withConfig(clusterId, async (api) =>
      this.fetchEvents(api('core'), opts));
    return rows;
  }

  /** Gemeinsamer Kern für `events()` und `describe()` — eine Verbindung, zwei Nutzer. */
  private async fetchEvents(
    coreClient: unknown,
    opts: { namespace?: string; involvedName?: string; limit?: number },
  ): Promise<KubeEventRow[]> {
    const spec = KUBE_KIND_SPECS.Event;
    const useNamespaced = Boolean(opts.namespace);
    const method = useNamespaced && spec.listNamespaced ? spec.listNamespaced : spec.listAll;
    const param: Record<string, unknown> = { limit: this.clampLimit(opts.limit) };
    if (useNamespaced) param.namespace = opts.namespace;

    const result = await this.callApi(coreClient, method, param);
    const items = isRecord(result) && Array.isArray(result.items) ? result.items : [];
    let rows = items.map((item) => this.projectEvent(item));
    if (opts.involvedName) {
      rows = rows.filter((r) => r.involvedName === opts.involvedName);
    }
    return this.sortEvents(rows);
  }

  async describe(
    clusterId: string,
    kindInput: string,
    name: string,
    namespace?: string,
  ): Promise<KubeDescribeResult> {
    const kind = this.assertKind(kindInput);
    const spec = KUBE_KIND_SPECS[kind];
    if (spec.namespaced && !namespace) {
      throw new BadRequestException(`${kind} braucht einen Namespace`);
    }

    // Beide Abfragen teilen sich EINE aufgelöste Config. Zwei getrennte
    // withConfig-Aufrufe würden bei Tunnel-Clustern zweimal acquiren und
    // freigeben — korrekt, aber unnötig teuer.
    return this.withConfig(clusterId, async (api) => {
      const client = api(spec.group);
      const param: Record<string, unknown> = { name };
      if (spec.namespaced) param.namespace = namespace;
      const raw = await this.callApi(client, spec.read, param);
      const stripped = stripHeavyMetadata(raw);
      const object = kind === 'Secret' ? redactSecret(stripped) : stripped;

      const conditions: KubeCondition[] = [];
      if (isRecord(stripped) && isRecord(stripped.status) && Array.isArray(stripped.status.conditions)) {
        for (const c of stripped.status.conditions) {
          if (!isRecord(c)) continue;
          // `asString` statt eines lokalen `typeof`-Tests: `lastTransitionTime`
          // kommt als `Date` an und ging vorher für JEDE Condition verloren —
          // ausgerechnet an dem Werkzeug, das „warum läuft das nicht"
          // beantworten soll (siehe JSDoc in kube-normalize.ts).
          conditions.push({
            type: asString(c.type), status: asString(c.status), reason: asString(c.reason),
            message: asString(c.message), lastTransitionTime: asString(c.lastTransitionTime),
          });
        }
      }

      const events = await this.fetchEvents(api('core'), { namespace, involvedName: name });
      return { object, events, conditions };
    });
  }
}
