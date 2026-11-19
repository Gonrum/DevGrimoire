import { SetMetadata } from '@nestjs/common';
import type { PermissionId } from '../../common/permissions';

export const PERMISSION_GATE_KEY = 'permissionGate';
export const ADMIN_PERMISSION_KEY = 'adminPermission';

/**
 * How the entry gate treats a route for actors with a permission allowlist
 * (see `common/permissions.ts`). Default: GET/HEAD are reads, everything else
 * is a content write that needs `project:write` or `customer:write`.
 *
 * - `service`: the service checks the precise catalog permission
 *   (`project:todo:write`, …); the entry gate stays out of the way so a key
 *   limited to that permission is not rejected for lacking `project:write`.
 * - `write`: treat as a write even for GET — for routes that expose
 *   infrastructure (file downloads from servers, workspace files, cluster
 *   logs) where "read" is as powerful as a write.
 */
export const PermissionGate = (mode: 'service' | 'write') => SetMetadata(PERMISSION_GATE_KEY, mode);

/**
 * The `admin:*` permission an admin route needs when the actor carries an
 * allowlist. Admin routes without this decorator fall back to
 * `admin:settings:manage` (instance configuration).
 */
export const AdminPermission = (perm: PermissionId) => SetMetadata(ADMIN_PERMISSION_KEY, perm);
