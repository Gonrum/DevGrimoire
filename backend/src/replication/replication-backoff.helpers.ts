/** Transport-error classification + backoff math for the sync driver. Pure. */

export type ErrorClass = 'terminal' | 'retryable';
export type DirectionState = 'healthy' | 'degraded' | 'error' | 'paused';

/** Terminal errors need admin action (auth/role/validation) — retrying as-is
 *  will never succeed. Everything else (5xx, 429, 404, network, timeout, no
 *  response) is transient and worth retrying with backoff. */
export function classifyHttpError(err: unknown): ErrorClass {
  const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === 422) return 'terminal';
  return 'retryable';
}

/** Exponential backoff: base·2^(failures-1), capped. `failures<=0` → 0 (no wait). */
export function computeBackoffMs(consecutiveFailures: number, baseMs: number, capMs: number): number {
  if (consecutiveFailures <= 0) return 0;
  const raw = baseMs * Math.pow(2, consecutiveFailures - 1);
  return Math.min(raw, capMs);
}

/** Direction health for the status endpoint. Inactive driver dominates. */
export function deriveDirectionState(
  active: boolean,
  consecutiveFailures: number,
  lastErrorClass: ErrorClass | null,
): DirectionState {
  if (!active) return 'paused';
  if (consecutiveFailures === 0) return 'healthy';
  if (lastErrorClass === 'terminal') return 'error';
  return 'degraded';
}
