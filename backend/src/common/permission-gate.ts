/**
 * Entry gate for content outside the permission catalog, shared by the REST
 * guard and the MCP tool dispatcher. Only relevant for actors with an explicit
 * permission allowlist; everyone else passes (see `common/permissions.ts`).
 */

/** MCP tools whose service checks the precise catalog permission itself. */
const SERVICE_CHECKED_TOOLS: ReadonlySet<string> = new Set([
  'secret_set', 'secret_delete',
  'attachment_upload', 'attachment_delete',
  'knowledge_save', 'knowledge_update', 'knowledge_delete',
  'todo_create', 'todo_update', 'todo_delete', 'todo_comment',
  'monitor_create', 'monitor_update', 'monitor_delete', 'monitor_run',
  'contact_create', 'contact_update', 'contact_delete',
  'customer_create', 'customer_update', 'customer_archive',
  'project_create', 'project_update', 'project_delete',
]);

/** Read-shaped tools that still expose infrastructure and count as writes. */
const INFRA_PREFIXES = ['ssh_', 'kube_', 'workspace_'];
const INFRA_READ_TOOLS: ReadonlySet<string> = new Set([
  'ssh_connection_get', 'ssh_connection_list',
  'kube_cluster_get', 'kube_cluster_list',
  'workspace_get', 'workspace_list', 'workspace_status',
]);

const READ_SUFFIXES = [
  '_get', '_list', '_search', '_status', '_history', '_versions', '_summary',
  '_stats', '_neighbors', '_impact', '_inspect', '_preview', '_export', '_links',
  '_markdown', '_validate',
];
const READ_TOOLS: ReadonlySet<string> = new Set([
  'web_search', 'web_fetch', 'user_list_active', 'workflow_node_types_list',
  // The service checks project:file:read / customer:file:read.
  'attachment_download',
]);

export type ToolAccessClass = 'read' | 'write' | 'service';

export function toolAccessClass(name: string): ToolAccessClass {
  if (SERVICE_CHECKED_TOOLS.has(name)) return 'service';
  if (INFRA_PREFIXES.some((p) => name.startsWith(p))) {
    return INFRA_READ_TOOLS.has(name) ? 'read' : 'write';
  }
  if (READ_TOOLS.has(name)) return 'read';
  if (READ_SUFFIXES.some((s) => name.endsWith(s))) return 'read';
  return 'write';
}

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function httpAccessClass(method: string, gate: 'service' | 'write' | undefined): ToolAccessClass {
  if (gate) return gate;
  return READ_METHODS.has(method.toUpperCase()) ? 'read' : 'write';
}
