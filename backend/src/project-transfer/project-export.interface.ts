export interface ProjectExport {
  _exportVersion: 1;
  _exportedAt: string;
  _source: 'DevGrimoire';
  project: Record<string, unknown>;
  todos: Record<string, unknown>[];
  milestones: Record<string, unknown>[];
  changelog: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  knowledge: Record<string, unknown>[];
  research: Record<string, unknown>[];
  environments: Record<string, unknown>[];
  secrets: Record<string, unknown>[];
  manuals: Record<string, unknown>[];
  schemas: Array<Record<string, unknown> & { _versions?: Record<string, unknown>[] }>;
  dependencies: Record<string, unknown>[];
  features: Record<string, unknown>[];
}
