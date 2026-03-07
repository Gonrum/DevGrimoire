import { Todo } from '../api/client';

export const COLUMNS: { key: Todo['status']; label: string; color: string }[] = [
  { key: 'open', label: 'Offen', color: 'border-gray-600' },
  { key: 'in_progress', label: 'In Arbeit', color: 'border-yellow-500' },
  { key: 'review', label: 'Review', color: 'border-purple-500' },
  { key: 'done', label: 'Erledigt', color: 'border-green-500' },
];

export const PRIORITY_COLORS: Record<Todo['priority'], string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-gray-500',
};

export const PRIORITY_LABELS: Record<Todo['priority'], string> = {
  critical: 'Kritisch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

export const STATUS_LABELS: Record<Todo['status'], string> = {
  open: 'Offen',
  in_progress: 'In Arbeit',
  review: 'Review',
  done: 'Erledigt',
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

export const STATUS_TRANSITIONS: Record<Todo['status'], { label: string; next: Todo['status'] }[]> = {
  open: [{ label: 'Starten', next: 'in_progress' }],
  in_progress: [
    { label: 'Zurück', next: 'open' },
    { label: 'Review', next: 'review' },
  ],
  review: [
    { label: 'Zurück', next: 'in_progress' },
    { label: 'Fertig', next: 'done' },
  ],
  done: [{ label: 'Wieder öffnen', next: 'open' }],
};
