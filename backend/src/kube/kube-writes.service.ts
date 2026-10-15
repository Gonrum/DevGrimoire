import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig, NetworkingV1Api, loadAllYaml,
} from '@kubernetes/client-node';
import { KubeClustersService } from './kube-clusters.service';
import { KubeClientService } from './kube-client.service';
import { KubeAuditService } from './kube-audit.service';
import { canAccessCluster } from './kube-access.guard';
import { KUBE_KIND_SPECS, KubeApiGroup, KubeKind, isKubeKind } from './kube-kinds';
import { KubeAuditSourceContext } from './schemas/kube-audit.schema';
import { ActorScope } from '../common/permissions';
import { errorMessage, isRecord } from '../common/narrow';

export type KubeWriteVerb = 'scale' | 'restart' | 'delete' | 'cordon' | 'apply';

export interface KubeWriteResult {
  verb: KubeWriteVerb;
  resource: string;
  name: string;
  namespace?: string;
  detail?: string;
}

export const SCALABLE_KINDS: readonly string[] = ['Deployment', 'StatefulSet'];
export const RESTARTABLE_KINDS: readonly string[] = ['Deployment', 'StatefulSet', 'DaemonSet'];
export const DELETABLE_KINDS: readonly string[] = ['Pod', 'Job'];

const REPLICAS_MAX = 1000;

/** apiVersion, die ein Dokument für die jeweilige API-Gruppe tragen muss. */
const API_VERSION_BY_GROUP: Readonly<Record<KubeApiGroup, string>> = {
  core: 'v1',
  apps: 'apps/v1',
  batch: 'batch/v1',
  networking: 'networking.k8s.io/v1',
};

interface Guarded {
  clusterId: string;
  actor: ActorScope | undefined;
  userId: string;
  /** Herkunft für die Audit-Zeile; REST ist der Default. */
  sourceContext?: KubeAuditSourceContext;
}

interface WriteMeta {
  verb: KubeWriteVerb;
  resource: string;
  name: string;
  namespace?: string;
}

type ApiFor = (group: KubeApiGroup) => unknown;

interface ApplyDoc {
  kind: KubeKind;
  name: string;
  body: Record<string, unknown>;
}

function isApiMethod(value: unknown): value is (param: Record<string, unknown>) => Promise<unknown> {
  return typeof value === 'function';
}

@Injectable()
export class KubeWritesService {
  constructor(
    private readonly clusters: KubeClustersService,
    private readonly client: KubeClientService,
    private readonly audit: KubeAuditService,
  ) {}

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
   * Führt eine Schreibaktion aus und schreibt danach IMMER eine Audit-Zeile —
   * auch wenn sie fehlschlug. In K2 wurde festgestellt, dass fehlgeschlagene
   * Reads keine Spur hinterlassen; bei einem Schreibversuch ist genau der
   * Versuch die Information, die man später sucht.
   *
   * Reihenfolge ist Absicht: readOnly und Scope werden geprüft, bevor
   * `buildConfig` überhaupt gerufen wird. Die Checks erzwingen das über
   * `built === 0` — eine abgelehnte Aktion darf keinen Tunnel aufbauen.
   */
  private async run<T>(
    g: Guarded,
    meta: WriteMeta,
    fn: (api: ApiFor) => Promise<T>,
    validate?: () => void,
  ): Promise<T> {
    // Unbekannter Cluster (404) wirft ohne Audit-Zeile: es gibt keinen Cluster,
    // dem sie zugeordnet werden könnte. Ab hier ist jeder Abbruch eine Zeile.
    const cluster = await this.clusters.findById(g.clusterId);
    const started = Date.now();
    let errorMsg: string | undefined;
    try {
      this.assertWritable(cluster, g);
      validate?.();
      // buildConfig steht im try: ein fehlgeschlagener Tunnel oder eine nicht
      // entschlüsselbare Kubeconfig ist ein Versuch, den man später sucht.
      // `release` existiert nur, wenn buildConfig gelungen ist.
      const { kc, release } = await this.client.buildConfig(cluster);
      try {
        return await fn((group) => this.apiFor(kc, group));
      } finally {
        release();
      }
    } catch (err) {
      errorMsg = errorMessage(err);
      throw err;
    } finally {
      await this.record(g, meta, started, errorMsg);
    }
  }

  private assertWritable(
    cluster: Awaited<ReturnType<KubeClustersService['findById']>>,
    g: Guarded,
  ): void {
    if (cluster.readOnly) {
      throw new ForbiddenException(
        'Dieser Cluster ist als read-only markiert; Schreibaktionen sind dort abgeschaltet.',
      );
    }
    if (!canAccessCluster(cluster, g.actor)) {
      throw new ForbiddenException(`Kein Zugriff auf den Cluster "${cluster.label}"`);
    }
  }

  private async record(g: Guarded, meta: WriteMeta, started: number, errorMsg: string | undefined): Promise<void> {
    await this.audit.record({
      clusterId: g.clusterId, action: 'write', sourceContext: g.sourceContext ?? 'rest',
      userId: g.userId, verb: meta.verb, resource: meta.resource,
      namespace: meta.namespace, name: meta.name,
      durationMs: Date.now() - started, errorMsg,
    });
  }

  private assertIn(kind: string, allowed: readonly string[], verb: string): void {
    if (!allowed.includes(kind)) {
      throw new BadRequestException(
        `${verb} ist für "${kind}" nicht vorgesehen (erlaubt: ${allowed.join(', ')})`,
      );
    }
  }

  async scale(a: Guarded & { kind: string; name: string; namespace: string; replicas: number }): Promise<KubeWriteResult> {
    const validate = (): void => {
      this.assertIn(a.kind, SCALABLE_KINDS, 'Skalieren');
      if (!Number.isInteger(a.replicas) || a.replicas < 0 || a.replicas > REPLICAS_MAX) {
        throw new BadRequestException(`replicas muss eine ganze Zahl zwischen 0 und ${REPLICAS_MAX} sein`);
      }
    };
    return this.run(a, { verb: 'scale', resource: a.kind, name: a.name, namespace: a.namespace },
      async (api) => {
        const apps = api('apps');
        // Der Scale-Subresource-Weg statt eines vollen replace: er überschreibt
        // nichts, was jemand anderes am Objekt geändert hat.
        const current = await this.callApi(apps, `readNamespaced${a.kind}Scale`,
          { name: a.name, namespace: a.namespace });
        const body = isRecord(current)
          ? { ...current, spec: { replicas: a.replicas } }
          : { spec: { replicas: a.replicas } };
        await this.callApi(apps, `replaceNamespaced${a.kind}Scale`,
          { name: a.name, namespace: a.namespace, body });
        return { verb: 'scale', resource: a.kind, name: a.name, namespace: a.namespace,
                 detail: `replicas=${a.replicas}` };
      }, validate);
  }

  async restart(a: Guarded & { kind: string; name: string; namespace: string }): Promise<KubeWriteResult> {
    const validate = (): void => this.assertIn(a.kind, RESTARTABLE_KINDS, 'Rollout neu starten');
    return this.run(a, { verb: 'restart', resource: a.kind, name: a.name, namespace: a.namespace },
      async (api) => {
        const apps = api('apps');
        // client-node 2.0.0 sendet bei patchNamespaced* application/json-patch+json;
        // ein Merge-Objekt ergäbe 422, und ein JSON-Patch-`add` auf die Annotation
        // scheitert, wenn `annotations` fehlt. Daher read-modify-replace.
        const current = await this.callApi(apps, `readNamespaced${a.kind}`,
          { name: a.name, namespace: a.namespace });
        if (!isRecord(current)) throw new BadRequestException(`${a.kind} "${a.name}" nicht lesbar`);
        const stamp = new Date().toISOString();
        // Bestehende Annotationen erhalten — ein Replace, das sie verwirft, würde
        // fremde Metadaten löschen (Argo, Flux, Ingress-Controller hängen daran).
        const spec = isRecord(current.spec) ? current.spec : {};
        const tpl = isRecord(spec.template) ? spec.template : {};
        const tplMeta = isRecord(tpl.metadata) ? tpl.metadata : {};
        const anns = isRecord(tplMeta.annotations) ? tplMeta.annotations : {};
        // Exakt das, was `kubectl rollout restart` tut — damit ein späteres
        // `rollout status` dasselbe sieht wie unsere UI.
        const body = {
          ...current,
          spec: { ...spec, template: { ...tpl, metadata: { ...tplMeta,
            annotations: { ...anns, 'kubectl.kubernetes.io/restartedAt': stamp } } } },
        };
        // Das resourceVersion aus dem Read bleibt in `...current` erhalten:
        // ein paralleler Schreiber führt zu 409 statt zu stillem Überschreiben.
        await this.callApi(apps, `replaceNamespaced${a.kind}`,
          { name: a.name, namespace: a.namespace, body });
        return { verb: 'restart', resource: a.kind, name: a.name, namespace: a.namespace, detail: stamp };
      }, validate);
  }

  async remove(a: Guarded & { kind: string; name: string; namespace: string }): Promise<KubeWriteResult> {
    const validate = (): void => this.assertIn(a.kind, DELETABLE_KINDS, 'Löschen');
    return this.run(a, { verb: 'delete', resource: a.kind, name: a.name, namespace: a.namespace },
      async (api) => {
        const param: Record<string, unknown> = { name: a.name, namespace: a.namespace };
        if (a.kind === 'Job') {
          // Ohne propagationPolicy verwaist die Batch-API die Pods eines Jobs.
          await this.callApi(api('batch'), 'deleteNamespacedJob', { ...param, propagationPolicy: 'Background' });
        } else {
          await this.callApi(api('core'), 'deleteNamespacedPod', param);
        }
        return { verb: 'delete', resource: a.kind, name: a.name, namespace: a.namespace };
      }, validate);
  }

  async cordon(a: Guarded & { node: string; unschedulable: boolean }): Promise<KubeWriteResult> {
    return this.run(a, { verb: 'cordon', resource: 'Node', name: a.node },
      async (api) => {
        // JSON-Patch-Array: client-node 2.0.0 sendet patchNode als
        // application/json-patch+json. `add` setzt den Wert, auch wenn
        // spec.unschedulable noch nicht existiert (`replace` würde dann scheitern).
        await this.callApi(api('core'), 'patchNode', {
          name: a.node,
          body: [{ op: 'add', path: '/spec/unschedulable', value: a.unschedulable }],
        });
        return { verb: 'cordon', resource: 'Node', name: a.node,
                 detail: a.unschedulable ? 'cordon' : 'uncordon' };
      });
  }

  /**
   * Apply deckt genau die namespaced Kinds aus `KUBE_KIND_SPECS` ab; alles
   * andere wird vor dem Verbindungsaufbau mit 400 abgelehnt. Semantik:
   * lesen, bei 404 anlegen, sonst mit dem gelesenen resourceVersion ersetzen
   * (kein Server-Side-Apply, kein Force: ein Konflikt ist ein Fehler).
   */
  async apply(a: Guarded & { yaml: string; namespace: string }): Promise<KubeWriteResult[]> {
    // Parse und Validierung laufen NACH dem Laden des Clusters und hinter
    // readOnly/Scope, damit auch ein abgelehnter Apply eine Audit-Zeile hinterlässt.
    const cluster = await this.clusters.findById(a.clusterId);
    const started = Date.now();
    let parsed: ApplyDoc[];
    try {
      this.assertWritable(cluster, a);
      parsed = this.parseApply(a.yaml, a.namespace);
    } catch (err) {
      await this.record(a, { verb: 'apply', resource: 'yaml', name: '-', namespace: a.namespace },
        started, errorMessage(err));
      throw err;
    }

    // Ein `run` pro Dokument: eigener Transport und eigene Audit-Zeile je
    // Dokument. Bei einem Fehler bleiben bereits angewendete Dokumente bestehen.
    const results: KubeWriteResult[] = [];
    for (const d of parsed) {
      const one = await this.run(a, { verb: 'apply', resource: d.kind, name: d.name, namespace: a.namespace },
        async (api) => {
          const detail = await this.applyOne(api, d, a.namespace);
          return { verb: 'apply' as const, resource: d.kind, name: d.name, namespace: a.namespace, detail };
        });
      results.push(one);
    }
    return results;
  }

  private parseApply(yaml: string, namespace: string): ApplyDoc[] {
    let raw: unknown[];
    try {
      raw = loadAllYaml(yaml);
    } catch {
      // Die Parserfehlermeldung kann Teile des Inputs zitieren, und der Input
      // ist hier fremdes YAML.
      throw new BadRequestException('YAML konnte nicht geparst werden');
    }
    // Leere Dokumente (z.B. ein abschliessendes `---`) liefert der Parser als null.
    const docs = raw.filter((d) => d !== null && d !== undefined);
    if (docs.length === 0) throw new BadRequestException('Kein Dokument im YAML');
    return docs.map((doc) => this.validateApplyDoc(doc, namespace));
  }

  private validateApplyDoc(doc: unknown, namespace: string): ApplyDoc {
    if (!isRecord(doc) || typeof doc.kind !== 'string' || typeof doc.apiVersion !== 'string') {
      throw new BadRequestException('Jedes Dokument braucht apiVersion und kind');
    }
    const meta = doc.metadata;
    if (!isRecord(meta) || typeof meta.name !== 'string' || meta.name.length === 0) {
      throw new BadRequestException('Jedes Dokument braucht metadata.name');
    }
    if (typeof meta.namespace === 'string' && meta.namespace !== namespace) {
      throw new BadRequestException(
        `Dokument "${meta.name}" trägt Namespace "${meta.namespace}", angefragt war "${namespace}"`,
      );
    }
    if (!isKubeKind(doc.kind) || !KUBE_KIND_SPECS[doc.kind].namespaced) {
      throw new BadRequestException(
        `apply unterstützt "${doc.kind}" nicht (nur namespaced Kinds, die DevGrimoire kennt); ` +
        'andere Ressourcen lassen sich aus DevGrimoire nicht anwenden',
      );
    }
    const expected = API_VERSION_BY_GROUP[KUBE_KIND_SPECS[doc.kind].group];
    if (doc.apiVersion !== expected) {
      throw new BadRequestException(
        `${doc.kind} "${meta.name}": apiVersion muss "${expected}" sein, ist "${doc.apiVersion}"`,
      );
    }
    return { kind: doc.kind, name: meta.name, body: doc };
  }

  /** Read, bei 404 create, sonst replace mit dem gelesenen resourceVersion. */
  private async applyOne(api: ApiFor, d: ApplyDoc, namespace: string): Promise<string> {
    const spec = KUBE_KIND_SPECS[d.kind];
    const client = api(spec.group);
    const param = { name: d.name, namespace };
    const meta = isRecord(d.body.metadata) ? d.body.metadata : {};

    let current: unknown;
    try {
      current = await this.callApi(client, spec.read, param);
    } catch (err) {
      if (!(isRecord(err) && err.code === 404)) throw err;
      current = undefined;
    }

    if (current === undefined) {
      const body = { ...d.body, metadata: { ...meta, namespace } };
      await this.callApi(client, spec.read.replace(/^read/, 'create'), { namespace, body });
      return 'created';
    }
    const currentMeta = isRecord(current) && isRecord(current.metadata) ? current.metadata : {};
    const body = {
      ...d.body,
      metadata: { ...meta, namespace, resourceVersion: currentMeta.resourceVersion },
    };
    await this.callApi(client, spec.read.replace(/^read/, 'replace'), { ...param, body });
    return 'replaced';
  }

  /** Prüft die Methode am generierten Client, statt sie zu behaupten. */
  private async callApi(client: unknown, method: string, param: Record<string, unknown>): Promise<unknown> {
    if (!isRecord(client)) {
      throw new BadRequestException(`Cluster-API kennt "${method}" nicht`);
    }
    const fn = client[method];
    if (!isApiMethod(fn)) {
      throw new BadRequestException(`Cluster-API kennt "${method}" nicht`);
    }
    return fn.call(client, param);
  }
}
