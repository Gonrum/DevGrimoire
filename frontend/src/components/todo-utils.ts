import { Todo } from '../api/client';
import i18n from '../i18n';

const t = (key: string) => i18n.t(key);

export const COLUMNS: { key: Todo['status']; label: () => string; color: string }[] = [
  { key: 'open', label: () => t('todoStatus.open'), color: 'border-gray-600' },
  { key: 'in_progress', label: () => t('todoStatus.in_progress'), color: 'border-yellow-500' },
  { key: 'review', label: () => t('todoStatus.review'), color: 'border-purple-500' },
  { key: 'done', label: () => t('todoStatus.done'), color: 'border-green-500' },
];

export const PRIORITY_COLORS: Record<Todo['priority'], string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-gray-500',
};

export const PRIORITY_LABELS: Record<Todo['priority'], () => string> = {
  critical: () => t('todoPriority.critical'),
  high: () => t('todoPriority.high'),
  medium: () => t('todoPriority.medium'),
  low: () => t('todoPriority.low'),
};

export const STATUS_LABELS: Record<Todo['status'], () => string> = {
  open: () => t('todoStatus.open'),
  in_progress: () => t('todoStatus.in_progress'),
  review: () => t('todoStatus.review'),
  done: () => t('todoStatus.done'),
};

export const STATUS_COLORS: Record<Todo['status'], string> = {
  open: 'bg-gray-700 text-gray-300',
  in_progress: 'bg-yellow-900 text-yellow-300',
  review: 'bg-purple-900 text-purple-300',
  done: 'bg-green-900 text-green-300',
};

export const TRANSITION_BUTTON_COLORS: Record<Todo['status'], string> = {
  open: 'bg-gray-700 hover:bg-gray-600 text-gray-300',
  in_progress: 'bg-yellow-900/60 hover:bg-yellow-900 text-yellow-300',
  review: 'bg-purple-900/60 hover:bg-purple-900 text-purple-300',
  done: 'bg-green-900/60 hover:bg-green-900 text-green-300',
};

export const STATUS_TRANSITIONS: Record<Todo['status'], { label: () => string; next: Todo['status'] }[]> = {
  open: [{ label: () => t('todoTransitions.start'), next: 'in_progress' }],
  in_progress: [
    { label: () => t('todoTransitions.back'), next: 'open' },
    { label: () => t('todoTransitions.review'), next: 'review' },
  ],
  review: [
    { label: () => t('todoTransitions.back'), next: 'in_progress' },
    { label: () => t('todoTransitions.done'), next: 'done' },
  ],
  done: [{ label: () => t('todoTransitions.reopen'), next: 'open' }],
};
