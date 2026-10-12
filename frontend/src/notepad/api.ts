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

  /**
   * Wie `update`, aber mit `keepalive: true` — für den `beforeunload`-Pfad.
   *
   * Dort stand vorher `navigator.sendBeacon('/api/notes/' + id, blob)`, und das
   * hat aus zwei unabhängigen Gründen nie funktioniert: `sendBeacon` sendet
   * IMMER `POST`, und das Backend hat unter `@Controller('notes')` nur
   * `@Post()` (= `/notes`) und `@Put(':id')` — ein `POST /api/notes/:id` matcht
   * keine Route, also 404. Und `sendBeacon` kann keine Kopfzeilen setzen,
   * während `JwtAuthGuard` global als APP_GUARD hängt und der Controller kein
   * `@Public()` trägt — mit aktivierter Auth wäre es selbst bei existierender
   * Route ein 401. Beides zusammen: der letzte ungespeicherte Rest (alles
   * innerhalb des 500-ms-Debounce-Fensters vor dem Schliessen) ging IMMER
   * verloren, und zwar unsichtbar, weil der Rückgabewert nicht geprüft und der
   * Fehler geschluckt wurde — unter dem Kommentar „reliable flush".
   *
   * `keepalive` ist der moderne Ersatz: der Browser hält den Request über das
   * Entladen der Seite hinaus aufrecht, und weil er über `request()` läuft,
   * stimmt auch der Authorization-Header. Dieselbe Grenze wie beim Beacon:
   * ~64 KiB Body für alle gleichzeitig laufenden keepalive-Requests.
   */
  updateBeacon: (id: string, payload: { content: string }) =>
    request<Note>(`/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      keepalive: true,
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
