/**
 * Catalog of fine-grained permissions used in DevGrimoire.
 *
 * Permissions are encoded as `domain:resource:action` strings (or
 * `domain:resource` for read+write toggles where finer granularity is not yet
 * needed). The full design rationale lives in the project knowledge entry
 * "Permission-Modell für Customer/Project-Scope (T-210)".
 *
 * IMPORTANT: `role=admin` implicitly receives **all** permissions. Permission
 * checks in the codebase MUST short-circuit on admin role (see
 * `actorHasPermission` below) so existing admin flows keep working without
 * touching every endpoint.
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
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: string[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: string[];
}

const ADMIN_ROLE = 'admin';

/**
 * Returns true if the actor has the given permission. Admins bypass the check
 * entirely (see knowledge entry T-210 for rationale).
 */
export function actorHasPermission(actor: ActorScope | undefined, perm: PermissionId): boolean {
  if (!actor) return false;
  if (actor.role === ADMIN_ROLE) return true;
  return Array.isArray(actor.permissions) && actor.permissions.includes(perm);
}

/**
 * Returns true if the actor may access the given projectId. Default-allow when
 * no scope info exists on the actor (legacy users / pre-migration).
 *
 * NOTE: Admin role does NOT bypass scope. An admin who attaches a narrow-scope
 * API key wants exactly that — narrow scope. The role-based bypass only applies
 * to `actorHasPermission` (permission grants), not to data scope. Default
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
