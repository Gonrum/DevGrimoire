import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { ActorScope, ScopeMode } from './permissions';

export type { ScopeMode, ActorScope } from './permissions';

/**
 * OwnerMode of a sub-entity. See knowledge entry "Scope- und Relation-Modell"
 * for the full rules. Briefly:
 *   project  — projectId set, no customerId
 *   customer — customerId set, no projectId
 *   relation — both set, requires a CustomerProjectLink
 *   global   — neither set (only valid for entities that explicitly allow it)
 */
export type OwnerMode = 'project' | 'customer' | 'relation' | 'global';

export interface OwnerInput {
  projectId?: string | Types.ObjectId | null;
  customerId?: string | Types.ObjectId | null;
}

const isSet = (value: OwnerInput['projectId']): boolean =>
  value !== null && value !== undefined && String(value).trim() !== '';

export function inferOwnerMode(input: OwnerInput): OwnerMode {
  const hasProject = isSet(input.projectId);
  const hasCustomer = isSet(input.customerId);
  if (hasProject && hasCustomer) return 'relation';
  if (hasProject) return 'project';
  if (hasCustomer) return 'customer';
  return 'global';
}

export function assertOwnerMode(input: OwnerInput, allowed: OwnerMode[]): OwnerMode {
  const mode = inferOwnerMode(input);
  if (!allowed.includes(mode)) {
    throw new BadRequestException(
      `Ungültiger Owner-Scope: erlaubt sind [${allowed.join(', ')}], gefunden: ${mode}.`,
    );
  }
  return mode;
}

export type LinkLookup = (
  customerId: string,
  projectId: string,
) => Promise<boolean>;

/**
 * Verifies that a CustomerProjectLink exists for the given pair. Used by services
 * that accept entities in `relation` mode. The lookup is injected to avoid a
 * circular module dependency on customers.
 */
export async function requireRelation(
  customerId: string,
  projectId: string,
  lookup: LinkLookup,
): Promise<void> {
  const exists = await lookup(customerId, projectId);
  if (!exists) {
    throw new BadRequestException(
      `Kunde ${customerId} ist nicht mit Projekt ${projectId} verknüpft (kein CustomerProjectLink).`,
    );
  }
}

/**
 * Builds a Mongo filter snippet that constrains a list query to entities the
 * actor is allowed to see. The result is meant to be merged into the caller's
 * existing query via `Object.assign(query, buildScopeFilter(actor, { axis }))`.
 *
 * Returns `{}` if the actor has unrestricted scope on the requested axis (admin
 * role, missing scope info, or `mode=all`). Returns `{ <field>: { $in: [] } }`
 * (deliberately no-match) for `mode=none`. Returns `{ <field>: { $in: [...] } }`
 * for `mode=allowlist`.
 *
 * The axis option determines which scope axis is being filtered. For entities
 * that may carry both projectId and customerId, call this once per axis and
 * merge the results.
 */
export function buildScopeFilter(
  actor: ActorScope | undefined,
  options: { axis: 'project' | 'customer'; field?: string; includeNullForLegacy?: boolean },
): Record<string, unknown> {
  if (!actor) return {};
  const field = options.field ?? `${options.axis}Id`;
  const mode: ScopeMode =
    (options.axis === 'project' ? actor.projectScopeMode : actor.customerScopeMode) ?? 'all';

  if (mode === 'all') return {};
  if (mode === 'none') return { [field]: { $in: [] } };

  const ids = (options.axis === 'project' ? actor.allowedProjectIds : actor.allowedCustomerIds) ?? [];
  const objectIds: Array<string | Types.ObjectId> = [];
  for (const id of ids) {
    objectIds.push(id);
    if (Types.ObjectId.isValid(id)) objectIds.push(new Types.ObjectId(id));
  }

  if (options.includeNullForLegacy) {
    return { $or: [{ [field]: { $in: objectIds } }, { [field]: { $exists: false } }, { [field]: null }] };
  }
  return { [field]: { $in: objectIds } };
}

/**
 * Combines project- and customer-scope filters for entities that may carry
 * either or both axes (Todos, Knowledge, Attachments, Snippets, Research,
 * Manuals, Activities, Souls). The semantics are: an entity is visible if
 *
 *   (projectId is unset OR allowed) AND (customerId is unset OR allowed)
 *
 * This way a project-only entity passes the customer clause via the unset
 * branch, a customer-only entity passes the project clause the same way, and
 * a relation entity (both ids set) must pass both.
 *
 * Returns `{}` when the actor has no restriction on either axis. Returns an
 * `$and` clause otherwise. Caller merges via Object.assign (no key collision
 * because the result key is `$and`).
 */
export function buildDualScopeFilter(
  actor: ActorScope | undefined,
  options?: { projectField?: string; customerField?: string },
): Record<string, unknown> {
  const projField = options?.projectField ?? 'projectId';
  const custField = options?.customerField ?? 'customerId';
  const projF = buildScopeFilter(actor, { axis: 'project', field: projField, includeNullForLegacy: true });
  const custF = buildScopeFilter(actor, { axis: 'customer', field: custField, includeNullForLegacy: true });
  const clauses: Record<string, unknown>[] = [];
  if (Object.keys(projF).length) clauses.push(projF);
  if (Object.keys(custF).length) clauses.push(custF);
  if (clauses.length === 0) return {};
  return { $and: clauses };
}
