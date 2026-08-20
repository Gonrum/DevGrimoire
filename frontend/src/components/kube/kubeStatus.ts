/**
 * Client-side status derivation for a `KubeCluster` — mirrors
 * `frontend/src/components/ssh/sshStatus.ts`.
 *
 * Order matters:
 *   1. `error` — `lastConnectError` populated (most recent test failed).
 *   2. `ok` — `lastConnectedAt` set without a stale error.
 *   3. `never_tested` — fallback when a test never ran.
 */
export type KubeClusterStatus = 'ok' | 'error' | 'never_tested';

export interface KubeClusterStatusInput {
  lastConnectedAt?: string | null;
  lastConnectError?: { at: string; message: string } | null;
}

export function kubeStatusOf(c: KubeClusterStatusInput): KubeClusterStatus {
  if (c.lastConnectError) return 'error';
  if (c.lastConnectedAt) return 'ok';
  return 'never_tested';
}

/**
 * Feste Klassen-Map: dynamisch zusammengesetzte Tailwind-Klassen
 * (`bg-${x}-500`) überleben den Purge nicht (CLAUDE.md).
 */
const STATUS_CLASSES: Record<KubeClusterStatus, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
  never_tested: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

export function kubeStatusClasses(status: KubeClusterStatus): string {
  return STATUS_CLASSES[status];
}
