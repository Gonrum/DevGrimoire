import type { ResearchTopicDocument } from './schemas/research-topic.schema';
import type { RagScope } from './research-agent.tools';

// Re-exported so callers only need to import from this module for the whole
// "what scope does this run search over" concern. `RagScope` itself lives in
// research-agent.tools.ts (Task 12) — imported here as a type-only import so
// this module stays pure/dependency-free at runtime (erased at compile time,
// no circular runtime require).
export type { RagScope };

/** Ids the run's owner can currently see, as resolved by the CALLER (see
 * `ResearchAgentService.resolveScope`, which lists projects/customers via
 * `ProjectsService`/`CustomersService` INSIDE the owner's `RequestContext`).
 * Kept as plain data here — not a live service call — so this module has no
 * Mongo/Nest dependency and stays trivially unit-testable. */
export interface VisibleIds {
  projectIds: string[];
  customerIds: string[];
}

export interface ScopeResolution {
  scope: RagScope;
  /** Present only when a `mode: 'all'` expansion had to be capped at
   * `maxScopes` — the caller (`ResearchAgentService.run`) is responsible for
   * surfacing this via `onStep`/`runService.appendStep`; this function only
   * decides whether to truncate and computes the message. */
  note?: string;
}

/**
 * Hard cap on the number of concrete project/customer scopes a single
 * research run may fan out `RagService.searchScopes` across.
 *
 * COST RATIONALE: `RagService.searchScopes` does ONE embedding round-trip
 * PER scope (one `search()` call per projectId/customerId, plus one more if
 * `includeGlobal`), and the research agent calls `rag_search` several times
 * over the course of a single run. An unbounded `scope.mode==='all'` on an
 * instance with many projects/customers would therefore turn every single
 * `rag_search` tool call into dozens of embedding requests — this cap keeps
 * that fan-out bounded regardless of how large the instance grows. See
 * task-13 brief §1 ("HARD COST REQUIREMENT").
 */
export const MAX_SCOPES = 25;

function toIdStrings(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id));
}

/**
 * Direct scope for `scope.mode !== 'all'` (i.e. `'selected'`): the topic's
 * own explicit `projectIds`/`customerIds` (Mongoose ObjectId[] → string[]) +
 * `includeGlobal`. This is a finite, operator-chosen set already — no
 * expansion or bounding needed. Also used as `resolveRequestScope`'s
 * fallback branch for any non-`'all'` mode.
 */
export function scopeFrom(topic: ResearchTopicDocument): RagScope {
  const scope = topic.scope;
  return {
    projectIds: toIdStrings(scope?.projectIds),
    customerIds: toIdStrings(scope?.customerIds),
    includeGlobal: scope?.includeGlobal !== false,
  };
}

/**
 * Resolves the topic's `ResearchScope` into a concrete, cost-bounded scope
 * tuple for `RagService.searchScopes`.
 *
 * - `mode !== 'all'` (i.e. `'selected'`) → `scopeFrom(topic)` unchanged.
 * - `mode === 'all'` → expands to every project/customer id in `visible`
 *   (which the caller resolves via `ProjectsService`/`CustomersService`
 *   INSIDE the run owner's `RequestContext`, so it's already narrowed to
 *   what that user can see), then caps the COMBINED count at `maxScopes`
 *   (projects kept first, customers filling the remainder). If capping
 *   actually dropped any id, `note` carries the caller-facing message the
 *   brief requires: "Scope auf N Projekte begrenzt (von M)".
 */
export function resolveRequestScope(
  topic: ResearchTopicDocument,
  visible: VisibleIds,
  maxScopes: number = MAX_SCOPES,
): ScopeResolution {
  if (topic.scope?.mode !== 'all') {
    return { scope: scopeFrom(topic) };
  }

  const includeGlobal = topic.scope?.includeGlobal !== false;
  const totalAvailable = visible.projectIds.length + visible.customerIds.length;

  if (totalAvailable <= maxScopes) {
    return {
      scope: {
        projectIds: [...visible.projectIds],
        customerIds: [...visible.customerIds],
        includeGlobal,
      },
    };
  }

  const boundedProjectIds = visible.projectIds.slice(0, maxScopes);
  const remaining = Math.max(0, maxScopes - boundedProjectIds.length);
  const boundedCustomerIds = visible.customerIds.slice(0, remaining);
  const kept = boundedProjectIds.length + boundedCustomerIds.length;

  return {
    scope: { projectIds: boundedProjectIds, customerIds: boundedCustomerIds, includeGlobal },
    note: `Scope auf ${kept} Projekte begrenzt (von ${totalAvailable})`,
  };
}
