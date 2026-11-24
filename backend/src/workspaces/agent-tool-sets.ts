/**
 * Optional tool sets of the IDE agent, selectable per workspace
 * (`Workspace.agentToolSets`). The ws_* tools are always offered; these sets
 * add a few DevGrimoire tools on top. Nothing else reaches an IDE agent turn.
 */
export type WorkspaceAgentToolSet = 'todos' | 'knowledge';

export const WORKSPACE_AGENT_TOOL_SETS: WorkspaceAgentToolSet[] = ['todos', 'knowledge'];

/** Default for new workspaces and for legacy documents without the field. */
export const DEFAULT_AGENT_TOOL_SETS: WorkspaceAgentToolSet[] = ['todos', 'knowledge'];

export const AGENT_TOOL_SET_TOOLS: Record<WorkspaceAgentToolSet, readonly string[]> = {
  todos: ['todo_list', 'todo_get', 'todo_create', 'todo_comment'],
  knowledge: ['rag_search', 'knowledge_search', 'knowledge_get', 'knowledge_save'],
};

function isAgentToolSet(value: unknown): value is WorkspaceAgentToolSet {
  return value === 'todos' || value === 'knowledge';
}

/**
 * The stored sets of a workspace: a missing field (legacy document, lean read)
 * means both; unknown entries are dropped, duplicates collapse.
 */
export function agentToolSetsOf(ws: { agentToolSets?: unknown } | null | undefined): WorkspaceAgentToolSet[] {
  const raw = ws?.agentToolSets;
  if (!Array.isArray(raw)) return [...DEFAULT_AGENT_TOOL_SETS];
  return WORKSPACE_AGENT_TOOL_SETS.filter((set) => raw.some((entry) => isAgentToolSet(entry) && entry === set));
}

/** Normalised form of validated input: known sets only, fixed order, no duplicates. */
export function normalizeAgentToolSets(input: readonly WorkspaceAgentToolSet[]): WorkspaceAgentToolSet[] {
  return WORKSPACE_AGENT_TOOL_SETS.filter((set) => input.includes(set));
}

/**
 * Narrows an allowlist (already cut by the global setting and the role) to
 * what an IDE agent turn may use: every ws_* entry plus the tools of the
 * chosen sets. It never adds a name the allowlist does not already contain.
 */
export function ideAgentAllowlist(
  allowlist: readonly string[],
  sets: readonly WorkspaceAgentToolSet[],
  isAgentTool: (name: string) => boolean,
): string[] {
  const extra = new Set(sets.flatMap((set) => AGENT_TOOL_SET_TOOLS[set]));
  return allowlist.filter((name) => isAgentTool(name) || extra.has(name));
}
