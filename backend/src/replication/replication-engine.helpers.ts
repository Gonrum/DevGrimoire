/**
 * Engine selector (Plan 4 migration). Two replication engines coexist in the
 * codebase: the LEGACY fire-on-emit push + timestamp-pull, and the change-stream
 * LOG engine. `REPL_ENGINE` lets an operator cut over cleanly instead of running
 * both at once.
 */

export type ReplicationEngine = 'legacy' | 'log';

/** Default when unset. `legacy` so an existing instance keeps its behaviour
 *  until a deliberate cutover — the log-writer + sync-driver run on their own
 *  gates regardless, so this only ever *adds* the ability to silence legacy. */
export const DEFAULT_ENGINE: ReplicationEngine = 'legacy';

/** Normalize a raw setting to a known engine. Only the exact string 'log'
 *  selects the log engine; anything else (unset, 'legacy', typo) → legacy. */
export function resolveEngine(raw: unknown): ReplicationEngine {
  return raw === 'log' ? 'log' : DEFAULT_ENGINE;
}

/** Whether the LEGACY engine's active surfaces (on-emit push + enqueue, queue
 *  drain, full-sync cron, pull cron) should run. Only 'log' disables them. */
export function legacyEngineEnabled(raw: unknown): boolean {
  return resolveEngine(raw) === 'legacy';
}
