/**
 * View decisions for the project detail page (sidebar + overview).
 * Import-free on purpose so `scripts/project-detail-view-check.cjs` can
 * compile and test it standalone.
 */

/** Rarely used project tabs, tucked away under a collapsible "more" section. */
export const PROJECT_MORE_TABS: readonly string[] = [
  'http-requests', 'ssh', 'kube', 'recurring-tasks', 'workflows', 'commits', 'logs', 'access',
];

/** Same idea for the customer page (`automation` = workflow definitions there). */
export const CUSTOMER_MORE_TABS: readonly string[] = ['ssh', 'kube', 'automation'];

export function splitMore<T extends { key: string }>(
  items: T[],
  moreKeys: readonly string[],
): { main: T[]; more: T[] } {
  const main: T[] = [];
  const more: T[] = [];
  for (const item of items) (moreKeys.includes(item.key) ? more : main).push(item);
  return { main, more };
}

/**
 * The section is forced open when the active tab lives in it (deep link) or
 * while searching, so navigation never hides behind a collapsed toggle.
 */
export function moreOpen(
  stored: boolean,
  activeKey: string,
  searching: boolean,
  moreKeys: readonly string[],
): boolean {
  return stored || searching || moreKeys.includes(activeKey);
}

export function showCount(count: number | undefined): count is number {
  return typeof count === 'number' && count > 0;
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface OpenTodoLike {
  status: string;
  archived?: boolean;
  priority: string;
  updatedAt: string;
}

export function isOpenTodo(t: OpenTodoLike): boolean {
  return t.status !== 'done' && !t.archived;
}

/** Open todos by priority, then most recently updated; plus how many did not fit. */
export function pickOpenTodos<T extends OpenTodoLike>(todos: T[], limit: number): { shown: T[]; rest: number } {
  const open = todos.filter(isOpenTodo).sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return { shown: open.slice(0, limit), rest: Math.max(0, open.length - limit) };
}
