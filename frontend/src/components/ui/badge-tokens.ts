/**
 * Shared badge color tokens for ProjectDetail tabs.
 *
 * Same semantic meaning -> same token across all tabs:
 * - todo / milestone / feature status share the status palette
 * - priority shares the priority palette
 * - tags / categories / scopes / versions get their own visually distinct tones
 *
 * Use as `<Badge color={statusBadge('done')}>` etc.
 */

type TodoStatus = 'open' | 'in_progress' | 'review' | 'done';
type MilestoneStatus = 'open' | 'in_progress' | 'done';
type FeatureStatus = 'planned' | 'in_development' | 'released' | 'deprecated';
type Priority = 'low' | 'medium' | 'high' | 'critical';

const STATUS_PALETTE = {
  open: 'bg-gray-700 text-gray-300',
  inProgress: 'bg-yellow-900 text-yellow-300',
  review: 'bg-purple-900 text-purple-300',
  done: 'bg-green-900 text-green-300',
  released: 'bg-cyan-900 text-cyan-300',
  deprecated: 'bg-red-900/60 text-red-300',
} as const;

const PRIORITY_PALETTE: Record<Priority, string> = {
  low: 'bg-gray-700 text-gray-400',
  medium: 'bg-blue-900 text-blue-300',
  high: 'bg-orange-900 text-orange-300',
  critical: 'bg-red-900 text-red-300',
};

export function todoStatusBadge(status: TodoStatus): string {
  switch (status) {
    case 'open': return STATUS_PALETTE.open;
    case 'in_progress': return STATUS_PALETTE.inProgress;
    case 'review': return STATUS_PALETTE.review;
    case 'done': return STATUS_PALETTE.done;
  }
}

export function milestoneStatusBadge(status: MilestoneStatus): string {
  switch (status) {
    case 'open': return STATUS_PALETTE.open;
    case 'in_progress': return STATUS_PALETTE.inProgress;
    case 'done': return STATUS_PALETTE.done;
  }
}

export function featureStatusBadge(status: FeatureStatus): string {
  switch (status) {
    case 'planned': return STATUS_PALETTE.open;
    case 'in_development': return STATUS_PALETTE.inProgress;
    case 'released': return STATUS_PALETTE.released;
    case 'deprecated': return STATUS_PALETTE.deprecated;
  }
}

export function priorityBadge(priority: Priority): string {
  return PRIORITY_PALETTE[priority];
}

/** Distinguishing palette per content kind so they don't blur into each other. */
export const TAG_BADGE = 'bg-gray-800 text-gray-400';
export const CATEGORY_BADGE = 'bg-purple-900/40 text-purple-300';
export const SCOPE_GLOBAL_BADGE = 'bg-violet-900/40 text-violet-300';
export const SCOPE_PROJECT_BADGE = 'bg-gray-800 text-gray-500';
export const VERSION_BADGE = 'bg-violet-900/40 text-cyan-300';
export const COMPONENT_BADGE = 'bg-purple-900/40 text-purple-300';
