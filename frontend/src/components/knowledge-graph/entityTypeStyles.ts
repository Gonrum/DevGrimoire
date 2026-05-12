import type { KgEntityType, KgRelation } from '../../api/client';

export const ENTITY_TYPE_COLORS: Record<KgEntityType, { bg: string; border: string; text: string }> = {
  todo: { bg: '#0f172a', border: '#22d3ee', text: '#67e8f9' },
  milestone: { bg: '#1e1b4b', border: '#a78bfa', text: '#c4b5fd' },
  knowledge: { bg: '#082f49', border: '#38bdf8', text: '#7dd3fc' },
  manual: { bg: '#1e293b', border: '#fbbf24', text: '#fcd34d' },
  research: { bg: '#0c4a6e', border: '#06b6d4', text: '#67e8f9' },
  schema: { bg: '#14532d', border: '#34d399', text: '#6ee7b7' },
  feature: { bg: '#581c87', border: '#d946ef', text: '#e879f9' },
  dependency: { bg: '#451a03', border: '#fb923c', text: '#fdba74' },
  changelog: { bg: '#365314', border: '#a3e635', text: '#bef264' },
  workflow: { bg: '#1e3a8a', border: '#60a5fa', text: '#93c5fd' },
  release: { bg: '#365314', border: '#84cc16', text: '#bef264' },
  snippet: { bg: '#3f3f46', border: '#a1a1aa', text: '#d4d4d8' },
  commit: { bg: '#27272a', border: '#71717a', text: '#a1a1aa' },
  validation_report: { bg: '#7f1d1d', border: '#f87171', text: '#fca5a5' },
  doc_update_proposal: { bg: '#78350f', border: '#fcd34d', text: '#fde68a' },
  session: { bg: '#1e293b', border: '#64748b', text: '#94a3b8' },
};

export const RELATION_COLORS: Record<KgRelation, string> = {
  belongs_to: '#a78bfa',
  completed_by: '#84cc16',
  blocked_by: '#ef4444',
  tagged_overlap: '#38bdf8',
  category_match: '#fbbf24',
  validates: '#f87171',
  documents: '#fcd34d',
  depends_on: '#d946ef',
  mentions: '#a1a1aa',
  proposes_update: '#fcd34d',
  references: '#64748b',
};

export function entityHref(basePath: string, entityType: KgEntityType, entityId: string): string | null {
  switch (entityType) {
    case 'todo':
      return `${basePath}/todos/${entityId}`;
    case 'milestone':
      return `${basePath}/milestones/${entityId}`;
    case 'workflow':
      return `${basePath}/workflows/${entityId}`;
    default:
      return null;
  }
}
