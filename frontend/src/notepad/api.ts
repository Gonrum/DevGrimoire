import { request } from '../api/client';
import type { Note, PromotionCommitInput, PromotionCommitResult } from './types';

export const notesApi = {
  list: () => request<Note[]>('/notes'),

  listArchived: () => request<Note[]>('/notes/archived'),

  create: (payload?: { title?: string; content?: string }) =>
    request<Note>('/notes', {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),

  update: (id: string, payload: { title?: string; content?: string }) =>
    request<Note>(`/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  reorder: (orderedIds: string[]) =>
    request<void>('/notes/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds }),
    }),

  archive: (id: string) =>
    request<Note>(`/notes/${id}/archive`, { method: 'POST' }),

  snooze: (id: string) =>
    request<Note>(`/notes/${id}/snooze`, { method: 'POST' }),

  remove: (id: string) =>
    request<void>(`/notes/${id}`, { method: 'DELETE' }),

  promoteCommit: (id: string, payload: PromotionCommitInput) =>
    request<PromotionCommitResult>(`/notes/${id}/promote/commit`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
