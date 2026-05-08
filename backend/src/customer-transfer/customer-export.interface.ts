/**
 * Portable customer-export format v1 (T-238).
 *
 * Captures everything that lives **directly under a customer** — contacts,
 * customer-scoped knowledge, customer-scoped todos, customer-scoped
 * environments, customer-scoped secrets (redacted by default), research and
 * recurring tasks. Project-coupled data (CustomerProjectLinks, project-scoped
 * sub-entities) is intentionally not included because it doesn't survive a
 * cross-instance import — the receiving instance most likely doesn't have
 * those projects.
 */
export interface CustomerExport {
  _exportVersion: 1;
  _exportedAt: string;
  _source: 'DevGrimoire';
  _includesSecretValues: boolean;
  customer: Record<string, unknown>;
  contacts: Record<string, unknown>[];
  knowledge: Record<string, unknown>[];
  todos: Record<string, unknown>[];
  environments: Record<string, unknown>[];
  /** When _includesSecretValues=false, items have `value: null` and `_redacted: true`. */
  secrets: Record<string, unknown>[];
  research: Record<string, unknown>[];
  recurringTasks: Record<string, unknown>[];
}

export interface CustomerImportResult {
  customerId: string;
  imported: {
    contacts: number;
    knowledge: number;
    todos: number;
    environments: number;
    secrets: number;
    research: number;
    recurringTasks: number;
  };
  warnings: string[];
}
