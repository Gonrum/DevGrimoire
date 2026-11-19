import { ForbiddenException } from '@nestjs/common';
import {
  actorCanAccessCustomer,
  actorCanAccessProject,
  actorMay,
  actorPermissionsRestricted,
  ActorScope,
  Permission,
  PermissionId,
} from './permissions';
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

/**
 * Instance-wide configuration: admin role required (internal callers pass).
 * An admin with an explicit permission allowlist additionally needs
 * `admin:settings:manage`, the catch-all for instance configuration.
 */
export function assertAdmin(what: string): void {
  const actor = RequestContext.getUser();
  if (!actor) return;
  if (actor.role !== 'admin') {
    throw new ForbiddenException(`${what} requires the admin role`);
  }
  if (!actorMay(actor, Permission.ADMIN_SETTINGS_MANAGE)) {
    throw new ForbiddenException(`${what} requires the permission ${Permission.ADMIN_SETTINGS_MANAGE}`);
  }
}

// ---------------------------------------------------------------------------
// Fine-grained permissions (catalog in `common/permissions.ts`)
// ---------------------------------------------------------------------------

/** Catalog resources that exist on both the project and the customer axis. */
export type PermissionResource = 'secret' | 'file' | 'knowledge' | 'todo' | 'monitoring' | 'contact';
export type PermissionAction = 'read' | 'write';

function axisPermission(axis: 'project' | 'customer', resource: PermissionResource, action: PermissionAction): PermissionId | null {
  const wanted = `${axis}:${resource}:${action}`;
  const found = Object.values(Permission).find((p) => p === wanted);
  return found ?? null;
}

function deny(perm: string): never {
  throw new ForbiddenException(`Missing permission ${perm}`);
}

/** Throws 403 when the current actor lacks `perm` (internal callers pass). */
export function assertPermission(perm: PermissionId): void {
  const actor = RequestContext.getUser();
  if (!actor) return;
  if (!actorMay(actor, perm)) deny(perm);
}

/**
 * Permission check for one catalog resource of a given owner: a
 * project-bound entity needs `project:<resource>:<action>`, a customer-bound
 * one `customer:…`, a relation entity both. An owner without any axis (global
 * knowledge) passes with either axis' permission. Monitoring and contacts only
 * exist on the customer axis, so their project-side permission does not exist
 * and is treated as granted.
 */
export function assertOwnerPermission(owner: ScopedOwner, resource: PermissionResource, action: PermissionAction): void {
  const actor = RequestContext.getUser();
  const missing = missingOwnerPermission(actor, owner, resource, action);
  if (missing) deny(missing);
}

/** Pure variant for in-memory filtering (RAG hits). */
export function actorHasOwnerPermission(
  actor: ActorScope | undefined,
  owner: ScopedOwner,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  return missingOwnerPermission(actor, owner, resource, action) === null;
}

function missingOwnerPermission(
  actor: ActorScope | undefined,
  owner: ScopedOwner,
  resource: PermissionResource,
  action: PermissionAction,
): string | null {
  if (!actor || !actorPermissionsRestricted(actor)) return null;
  const projectPerm = axisPermission('project', resource, action);
  const customerPerm = axisPermission('customer', resource, action);
  const projectId = idOf(owner.projectId);
  const customerId = idOf(owner.customerId);
  if (!projectId && !customerId) {
    const either = (projectPerm && actorMay(actor, projectPerm)) || (customerPerm && actorMay(actor, customerPerm));
    return either ? null : (projectPerm ?? customerPerm ?? `${resource}:${action}`);
  }
  if (projectId && projectPerm && !actorMay(actor, projectPerm)) return projectPerm;
  if (customerId && customerPerm && !actorMay(actor, customerPerm)) return customerPerm;
  return null;
}

/**
 * Mongo filter fragment hiding the entities of one catalog resource whose
 * axis permission is missing — for lists and searches without an explicit
 * owner. Same entity rules as `assertOwnerPermission`; `{}` when the actor is
 * unrestricted or internal. Combine with `scopeFilter()` via `$and`, never via
 * `Object.assign` (both may carry `$and`).
 */
export function permissionFilter(
  resource: PermissionResource,
  options?: { projectField?: string; customerField?: string },
): Record<string, unknown> {
  const actor = RequestContext.getUser();
  if (!actor || !actorPermissionsRestricted(actor)) return {};
  const projField = options?.projectField ?? 'projectId';
  const custField = options?.customerField ?? 'customerId';
  const projectPerm = axisPermission('project', resource, 'read');
  const customerPerm = axisPermission('customer', resource, 'read');
  const projectOk = !projectPerm || actorMay(actor, projectPerm);
  const customerOk = !customerPerm || actorMay(actor, customerPerm);
  if (projectOk && customerOk) return {};
  // `{ field: null }` matches documents where the field is null or missing.
  if (projectOk) return { [custField]: null };
  if (customerOk) return { [projField]: null };
  return { _id: { $in: [] } };
}

/** `scopeFilter()` and `permissionFilter()` combined into one fragment. */
export function scopeAndPermissionFilter(
  resource: PermissionResource,
  options?: { projectField?: string; customerField?: string },
): Record<string, unknown> {
  const parts = [scopeFilter(options), permissionFilter(resource, options)].filter((f) => Object.keys(f).length > 0);
  if (parts.length === 0) return {};
  // Always wrapped in `$and`: a bare `{ projectId: null }` merged into a
  // caller filter would overwrite the caller's own `projectId` condition.
  return { $and: parts };
}

/**
 * Writes to content outside the catalog (milestones, snippets, workflows,
 * SSH, workspaces, …) need `project:write` or `customer:write` once the actor
 * carries an allowlist. The owner axis is not known at the REST/MCP entry, so
 * either one suffices there; the catalog resources are checked precisely in
 * their services.
 */
export function actorMayWriteContent(actor: ActorScope | undefined): boolean {
  if (!actor || !actorPermissionsRestricted(actor)) return true;
  return actorMay(actor, Permission.PROJECT_WRITE) || actorMay(actor, Permission.CUSTOMER_WRITE);
}

export function assertContentWrite(what: string): void {
  const actor = RequestContext.getUser();
  if (!actorMayWriteContent(actor)) {
    throw new ForbiddenException(`${what} requires the permission ${Permission.PROJECT_WRITE} or ${Permission.CUSTOMER_WRITE}`);
  }
}
