import { ForbiddenException } from '@nestjs/common';
import { actorCanAccessCustomer, actorCanAccessProject, ActorScope } from './permissions';
import { RequestContext } from './request-context';
import { buildDualScopeFilter, buildScopeFilter } from './scope';

/**
 * Central scope checks for services that own project- and/or customer-bound
 * entities.
 *
 * Same rule everywhere, mirroring `TodosService.assertAccess`: an axis that is
 * set must be in the actor's scope; an unset axis passes. A relation entity
 * (both ids set) therefore needs BOTH axes.
 *
 * No actor in the RequestContext means a trusted internal caller (scheduler,
 * stdio MCP) — the documented project convention. Code paths that run without
 * a request on behalf of a user must establish that user's actor with
 * `RequestContext.run(actor, …)` instead of relying on this bypass.
 *
 * The checks live in the SERVICES, not the controllers, so REST, MCP tools,
 * chat tools and workflow nodes all go through them.
 */

type IdLike = { toString(): string } | string | null | undefined;

export interface ScopedOwner {
  projectId?: IdLike;
  customerId?: IdLike;
}

const idOf = (v: IdLike): string | null => (v === null || v === undefined ? null : v.toString() || null);

/** Pure check against an explicit actor. */
export function actorCanSeeOwner(actor: ActorScope | undefined, owner: ScopedOwner): boolean {
  if (!actor) return false;
  const projectId = idOf(owner.projectId);
  const customerId = idOf(owner.customerId);
  const projectOk = !projectId || actorCanAccessProject(actor, projectId);
  const customerOk = !customerId || actorCanAccessCustomer(actor, customerId);
  return projectOk && customerOk;
}

/**
 * Throws 403 when the current actor may not access an entity with this owner.
 * `what` names the entity for the message ("Milestone 6a0f…") — never the
 * foreign project or customer id.
 */
export function assertOwnerInScope(owner: ScopedOwner, what: string): void {
  const actor = RequestContext.getUser();
  if (!actor) return;
  if (!actorCanSeeOwner(actor, owner)) {
    throw new ForbiddenException(`${what} is not in your scope`);
  }
}

/** For a `projectId` parameter (list by project, create in project). */
export function assertProjectInScope(projectId: IdLike): void {
  const actor = RequestContext.getUser();
  const id = idOf(projectId);
  if (!actor || !id) return;
  if (!actorCanAccessProject(actor, id)) {
    throw new ForbiddenException(`Project ${id} is not in your scope`);
  }
}

/** For a `customerId` parameter (list by customer, create for customer). */
export function assertCustomerInScope(customerId: IdLike): void {
  const actor = RequestContext.getUser();
  const id = idOf(customerId);
  if (!actor || !id) return;
  if (!actorCanAccessCustomer(actor, id)) {
    throw new ForbiddenException(`Customer ${id} is not in your scope`);
  }
}

/** Both parameters at once, e.g. for a create DTO that may carry either. */
export function assertOwnerParamsInScope(owner: ScopedOwner): void {
  assertProjectInScope(owner.projectId);
  assertCustomerInScope(owner.customerId);
}

/**
 * Mongo filter fragment restricting a list query to the current actor's scope
 * on both axes (entities without an axis stay visible). Merge it with
 * `Object.assign(filter, scopeFilter())`; `{}` when unrestricted or internal.
 */
export function scopeFilter(options?: { projectField?: string; customerField?: string }): Record<string, unknown> {
  return buildDualScopeFilter(RequestContext.getUser(), options);
}

/** Project axis only, for entities that are always project-bound. */
export function projectScopeFilter(field = 'projectId'): Record<string, unknown> {
  return buildScopeFilter(RequestContext.getUser(), { axis: 'project', field });
}

/**
 * Instance-wide entities (global knowledge, global harness layer, system
 * workflows) affect every project. Writing them requires an actor whose scope
 * is unrestricted on both axes — a narrowed user or key must not be able to
 * inject content into projects outside its scope.
 */
export function assertUnrestrictedScope(what: string): void {
  const actor = RequestContext.getUser();
  if (!actor) return;
  const proj = actor.projectScopeMode ?? 'all';
  const cust = actor.customerScopeMode ?? 'all';
  if (proj !== 'all' || cust !== 'all') {
    throw new ForbiddenException(`${what} requires unrestricted project and customer scope`);
  }
}

/** Instance-wide configuration: admin role required (internal callers pass). */
export function assertAdmin(what: string): void {
  const actor = RequestContext.getUser();
  if (!actor) return;
  if (actor.role !== 'admin') {
    throw new ForbiddenException(`${what} requires the admin role`);
  }
}
