import { Injectable, Logger } from '@nestjs/common';
import { AuthorizationV1Api, KubeConfig, VersionApi } from '@kubernetes/client-node';
import { KubeClustersService } from './kube-clusters.service';
import { KubeTransportService } from './kube-transport.service';
import { KubeAuditService } from './kube-audit.service';
import { KubeClusterDocument } from './schemas/kube-cluster.schema';
import { errorMessage } from '../common/narrow';

export interface KubeConnectionTestResult {
  ok: boolean;
  serverVersion?: string;
  /** Aus SelfSubjectRulesReview abgeleitet. */
  canWrite: boolean;
  verbs: string[];
  error?: string;
}

const WRITE_VERBS = new Set(['create', 'update', 'patch', 'delete', 'deletecollection', '*']);

interface RuleLike { verbs?: string[] }

/**
 * Wertet die Regeln aus SelfSubjectRulesReview aus. Getrennt exportiert,
 * damit das ohne Cluster prüfbar ist.
 */
export function deriveCanWrite(rules: RuleLike[]): { canWrite: boolean; verbs: string[] } {
  const verbs = new Set<string>();
  for (const rule of rules) {
    for (const verb of rule.verbs ?? []) verbs.add(verb);
  }
  const canWrite = [...verbs].some((v) => WRITE_VERBS.has(v));
  return { canWrite, verbs: [...verbs] };
}

@Injectable()
export class KubeClientService {
  private readonly logger = new Logger(KubeClientService.name);

  constructor(
    private readonly clusters: KubeClustersService,
    private readonly transport: KubeTransportService,
    private readonly audit: KubeAuditService,
  ) {}

  /**
   * Baut eine KubeConfig, deren Server auf den aufgelösten Endpunkt zeigt.
   * `release()` gibt den Tunnel-Refcount frei — IMMER aufrufen, sonst bleibt
   * der Tunnel bis zum Backend-Neustart offen. Jeder Ausstiegspfad ab dem
   * erfolgreichen `resolve()` muss entweder den `release`-Callback ans
   * aufrufende `finally` weiterreichen (Erfolgsfall) oder ihn selbst rufen,
   * bevor geworfen wird (Fehlerfall) — sonst hat niemand mehr einen Griff
   * darauf.
   *
   * `Cluster.server`/`Cluster.tlsServerName` sind im installierten
   * `@kubernetes/client-node` (2.0.0) als `readonly` typisiert
   * (`dist/config_types.d.ts`). Eine Zuweisung `current.server = …` wäre
   * daher ein TS-Fehler (und keiner, den ein Cast lösen sollte — das wäre
   * genau der Umweg, der laut Auftrag verboten ist). Stattdessen wird der
   * Cluster-Eintrag durch ein neues Objekt mit den überschriebenen Feldern
   * ersetzt; `readonly` verbietet nur die Zuweisung an eine bestehende
   * Referenz, nicht die Konstruktion eines neuen Objekts per Spread.
   */
  async buildConfig(
    cluster: KubeClusterDocument,
  ): Promise<{ kc: KubeConfig; release: () => void }> {
    const raw = await this.clusters.readKubeconfig(cluster);
    const endpoint = await this.transport.resolve(cluster);
    try {
      const kc = new KubeConfig();
      kc.loadFromString(raw);
      kc.setCurrentContext(cluster.contextName);

      const current = kc.getCurrentCluster();
      if (!current) {
        throw new Error(
          `Kubeconfig enthält keinen Cluster für Kontext "${cluster.contextName}"`,
        );
      }
      // Server auf den Tunnel umbiegen, echten Hostnamen als SNI behalten —
      // das hält die Zertifikatsprüfung intakt (der Tunnel ändert nur, wohin
      // verbunden wird, nicht welches Zertifikat als gültig gilt).
      kc.clusters = kc.clusters.map((c) => (
        c === current
          ? { ...c, server: endpoint.url, tlsServerName: endpoint.servername }
          : c
      ));

      return { kc, release: endpoint.release };
    } catch (err) {
      endpoint.release();
      throw err;
    }
  }

  async test(clusterId: string, userId: string): Promise<KubeConnectionTestResult> {
    const cluster = await this.clusters.findById(clusterId);
    const startedAt = Date.now();
    let release: (() => void) | undefined;
    try {
      const built = await this.buildConfig(cluster);
      release = built.release;

      const versionApi = built.kc.makeApiClient(VersionApi);
      const version = await versionApi.getCode();
      const serverVersion = version.gitVersion;

      const authApi = built.kc.makeApiClient(AuthorizationV1Api);
      const review = await authApi.createSelfSubjectRulesReview({
        body: {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectRulesReview',
          spec: { namespace: cluster.defaultNamespace ?? 'default' },
        },
      });
      const { canWrite, verbs } = deriveCanWrite(review.status?.resourceRules ?? []);

      await this.clusters.recordConnectSuccess(clusterId);
      await this.audit.record({
        clusterId, action: 'connect', sourceContext: 'rest', userId,
        durationMs: Date.now() - startedAt,
      });
      return { ok: true, serverVersion, canWrite, verbs };
    } catch (err) {
      const message = errorMessage(err);
      this.logger.warn(`Kube-Verbindungstest fehlgeschlagen (${clusterId}): ${message}`);
      await this.clusters.recordConnectError(clusterId, message);
      await this.audit.record({
        clusterId, action: 'connect', sourceContext: 'rest', userId,
        durationMs: Date.now() - startedAt, errorMsg: message,
      });
      return {
        ok: false, canWrite: false, verbs: [], error: message,
      };
    } finally {
      release?.();
    }
  }
}
