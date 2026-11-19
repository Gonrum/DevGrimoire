/**
 * Catalog of fine-grained permissions used in DevGrimoire.
 *
 * Permissions are encoded as `domain:resource:action` strings (or
 * `domain:resource` for read+write toggles where finer granularity is not yet
 * needed). The full design rationale lives in the project knowledge entry
 * "Permission-Modell für Customer/Project-Scope (T-210)".
 *
 * Semantics (enforced, see `actorMay`):
 * - An EMPTY list means "not restricted": the role decides. Non-admins get
 *   every `project:*` / `customer:*` permission (data access is then limited
 *   by scope only), `admin:*` requires the admin role. This keeps every
 *   existing user and key working unchanged.
 * - A NON-EMPTY list is an allowlist and applies to admins too — an admin who
 *   hands out a key limited to `project:todo:read` wants exactly that, the
 *   same rule as for data scope. An `admin:*` entry on a user's own list
 *   delegates that one admin capability (only admins can set user lists); a
 *   key can never hold a permission its owner lacks (`actorFromApiKey`).
 * - Any `project:*` entry implies `project:read` (the container must be
 *   visible to reach its todos), likewise for `customer:*`.
 * - Content outside the catalog (milestones, snippets, workflows, SSH, …):
 *   reads follow scope, writes need `project:write` or `customer:write`
 *   (`assertContentWrite`, enforced at the REST/MCP entry).
 */
export const Permission = {
  // Customer domain
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_WRITE: 'customer:write',
  CUSTOMER_ARCHIVE: 'customer:archive',
  CUSTOMER_CONTACT_READ: 'customer:contact:read',
  CUSTOMER_CONTACT_WRITE: 'customer:contact:write',
  CUSTOMER_SECRET_READ: 'customer:secret:read',
  CUSTOMER_SECRET_WRITE: 'customer:secret:write',
  CUSTOMER_FILE_READ: 'customer:file:read',
  CUSTOMER_FILE_WRITE: 'customer:file:write',
  CUSTOMER_MONITORING_READ: 'customer:monitoring:read',
  CUSTOMER_MONITORING_WRITE: 'customer:monitoring:write',
  CUSTOMER_KNOWLEDGE_READ: 'customer:knowledge:read',
  CUSTOMER_KNOWLEDGE_WRITE: 'customer:knowledge:write',
  CUSTOMER_TODO_READ: 'customer:todo:read',
  CUSTOMER_TODO_WRITE: 'customer:todo:write',

  // Project domain
  PROJECT_READ: 'project:read',
  PROJECT_WRITE: 'project:write',
  PROJECT_DELETE: 'project:delete',
  PROJECT_SECRET_READ: 'project:secret:read',
  PROJECT_SECRET_WRITE: 'project:secret:write',
  PROJECT_FILE_READ: 'project:file:read',
  PROJECT_FILE_WRITE: 'project:file:write',
  PROJECT_KNOWLEDGE_READ: 'project:knowledge:read',
  PROJECT_KNOWLEDGE_WRITE: 'project:knowledge:write',
  PROJECT_TODO_READ: 'project:todo:read',
  PROJECT_TODO_WRITE: 'project:todo:write',

  // Global admin permissions
  ADMIN_USER_MANAGE: 'admin:user:manage',
  ADMIN_APIKEY_MANAGE: 'admin:apikey:manage',
  ADMIN_AUDIT_READ: 'admin:audit:read',
  ADMIN_REPLICATION_MANAGE: 'admin:replication:manage',
  ADMIN_BACKUP_MANAGE: 'admin:backup:manage',
  ADMIN_SETTINGS_MANAGE: 'admin:settings:manage',
} as const;

export type PermissionId = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: PermissionId[] = Object.values(Permission);

/**
 * Per-axis access mode. See knowledge entry T-210 for the rationale why
 * project-scope and customer-scope are independent axes.
 */
export type ScopeMode = 'all' | 'allowlist' | 'none';

export interface ActorScope {
  role?: string;
  permissions?: string[];
  /** Explicit allowlist flag, see `actorPermissionsRestricted`. */
  permissionsRestricted?: boolean;
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: string[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: string[];
}

const ADMIN_ROLE = 'admin';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isKnownPermission(value: string): value is PermissionId {
  return KNOWN_PERMISSIONS.has(value);
}

/**
 * True when the actor carries an explicit permission allowlist. API-key actors
 * set `permissionsRestricted` explicitly, because the key/owner intersection
 * can be empty and an empty list alone would read as "unrestricted".
 */
export function actorPermissionsRestricted(actor: ActorScope): boolean {
  if (typeof actor.permissionsRestricted === 'boolean') return actor.permissionsRestricted;
  return Array.isArray(actor.permissions) && actor.permissions.length > 0;
}

/** Whether the actor holds `perm` under the semantics documented above. */
export function actorMay(actor: ActorScope | undefined, perm: PermissionId): boolean {
  if (!actor) return false;
  const isAdminPerm = perm.startsWith('admin:');
  if (!actorPermissionsRestricted(actor)) {
    return isAdminPerm ? actor.role === ADMIN_ROLE : true;
  }
  const list = actor.permissions ?? [];
  if (list.includes(perm)) return true;
  if (perm === Permission.PROJECT_READ) return list.some((p) => p.startsWith('project:'));
  if (perm === Permission.CUSTOMER_READ) return list.some((p) => p.startsWith('customer:'));
  return false;
}

/**
 * Kept for existing callers; same semantics as `actorMay`. Admins only pass
 * unconditionally while their permission list is unrestricted.
 */
export function actorHasPermission(actor: ActorScope | undefined, perm: PermissionId): boolean {
  return actorMay(actor, perm);
}

/**
 * Returns true if the actor may access the given projectId. Default-allow when
 * no scope info exists on the actor (legacy users / pre-migration).
 *
 * NOTE: Admin role does NOT bypass scope. An admin who attaches a narrow-scope
 * API key wants exactly that — narrow scope. The role-based bypass only applies
 * to unrestricted permission lists (`actorMay`), not to data scope. Default
 * `scopeMode='all'` already gives admins access to everything in normal use.
 */
export function actorCanAccessProject(actor: ActorScope | undefined, projectId: string | null | undefined): boolean {
  if (!actor) return false;
  const mode = actor.projectScopeMode ?? 'all';
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  if (!projectId) return false;
  return Array.isArray(actor.allowedProjectIds) && actor.allowedProjectIds.includes(String(projectId));
}

export function actorCanAccessCustomer(actor: ActorScope | undefined, customerId: string | null | undefined): boolean {
  if (!actor) return false;
  const mode = actor.customerScopeMode ?? 'all';
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  if (!customerId) return false;
  return Array.isArray(actor.allowedCustomerIds) && actor.allowedCustomerIds.includes(String(customerId));
}

/**
 * For a sub-entity in `relation` mode (both projectId and customerId set), the
 * actor needs access to **both** axes — never one alone. See T-210 knowledge
 * entry "Relation-Mode-Regel".
 */
export function actorCanAccessRelation(
  actor: ActorScope | undefined,
  customerId: string | null | undefined,
  projectId: string | null | undefined,
): boolean {
  return actorCanAccessProject(actor, projectId) && actorCanAccessCustomer(actor, customerId);
}
