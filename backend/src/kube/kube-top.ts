import {
  CoreV1Api, Metrics, NodeStatus, PodStatus, topNodes, topPods,
} from '@kubernetes/client-node';
import { errorMessage, isRecord } from '../common/narrow';
import { KubeClientService } from './kube-client.service';
import { KubeClusterDocument } from './schemas/kube-cluster.schema';

/**
 * `kubectl top` über den getypten Client — geteilt von `kube_top` (MCP) und
 * `dg kube top` (Workspace-CLI). Vorher lag die Logik inline in mcp-tools.ts.
 */

export const KUBE_TOP_SCOPES = ['pods', 'nodes'] as const;
export type KubeTopScope = typeof KUBE_TOP_SCOPES[number];

/**
 * `ResourceUsage`/`CurrentResourceUsage` fields from `@kubernetes/client-node`
 * are `number | bigint` (large memory quantities like "128974848Ki" overflow
 * a safe integer and come back as `bigint`) — `JSON.stringify` throws on a
 * raw `bigint`, so every value crosses to `string` before it can reach
 * `textResult`.
 */
function kubeUsageValue(value: number | bigint): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

/**
 * Narrow projection of `topPods()`'s `PodStatus` — NOT a pass-through.
 * `PodStatus.Pod` is the full raw `V1Pod` (managedFields, full annotations,
 * the works); returning it verbatim would be exactly the un-normalized
 * cluster JSON the output-normalization constraint exists to prevent.
 */
function projectPodTop(row: PodStatus): Record<string, unknown> {
  return {
    name: row.Pod.metadata?.name,
    namespace: row.Pod.metadata?.namespace,
    cpu: {
      usage: kubeUsageValue(row.CPU.CurrentUsage),
      requests: kubeUsageValue(row.CPU.RequestTotal),
      limits: kubeUsageValue(row.CPU.LimitTotal),
    },
    memory: {
      usage: kubeUsageValue(row.Memory.CurrentUsage),
      requests: kubeUsageValue(row.Memory.RequestTotal),
      limits: kubeUsageValue(row.Memory.LimitTotal),
    },
    containers: row.Containers.map((c) => ({
      name: c.Container,
      cpuUsage: kubeUsageValue(c.CPUUsage.CurrentUsage),
      memoryUsage: kubeUsageValue(c.MemoryUsage.CurrentUsage),
    })),
  };
}

/** Same reasoning as `projectPodTop` — `NodeStatus.Node` is a full raw `V1Node`. */
function projectNodeTop(row: NodeStatus): Record<string, unknown> {
  return {
    name: row.Node.metadata?.name,
    cpu: {
      capacity: kubeUsageValue(row.CPU.Capacity),
      requests: kubeUsageValue(row.CPU.RequestTotal),
      limits: kubeUsageValue(row.CPU.LimitTotal),
    },
    memory: {
      capacity: kubeUsageValue(row.Memory.Capacity),
      requests: kubeUsageValue(row.Memory.RequestTotal),
      limits: kubeUsageValue(row.Memory.LimitTotal),
    },
  };
}

function kubeMetricsErrorCode(err: unknown): number | undefined {
  return isRecord(err) && typeof err.code === 'number' ? err.code : undefined;
}

/**
 * `Metrics`/`topPods`/`topNodes` hit `metrics.k8s.io`, a separate optional API
 * that only exists if a metrics-server is deployed — its absence surfaces as
 * an `ApiException` with `.code` 404, same shape kube-resources.controller.ts
 * already decodes for the REST path. Rewritten into a message that says what
 * is actually missing instead of leaking the library's generic "Error
 * occurred in metrics request".
 */
function kubeTopError(err: unknown): Error {
  if (kubeMetricsErrorCode(err) === 404) {
    return new Error(
      'metrics-server ist im Cluster nicht installiert oder metrics.k8s.io nicht erreichbar (404 von der Metrics-API)',
    );
  }
  return err instanceof Error ? err : new Error(errorMessage(err));
}

/**
 * Holt die Metriken und projiziert sie. `release()` läuft genau einmal pro
 * `buildConfig()` — im finally, auf jedem Ausgang.
 */
export async function kubeTop(
  kubeClient: KubeClientService,
  cluster: KubeClusterDocument,
  scope: KubeTopScope,
  namespace?: string,
): Promise<Record<string, unknown>[]> {
  const { kc, release } = await kubeClient.buildConfig(cluster);
  try {
    const coreApi = kc.makeApiClient(CoreV1Api);
    if (scope === 'nodes') {
      const rows = await topNodes(coreApi);
      return rows.map((r) => projectNodeTop(r));
    }
    const metrics = new Metrics(kc);
    const rows = await topPods(coreApi, metrics, namespace);
    return rows.map((r) => projectPodTop(r));
  } catch (err) {
    throw kubeTopError(err);
  } finally {
    release();
  }
}
