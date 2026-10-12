import { ActorScope, actorCanAccessProject } from '../common/permissions';
import type { ProjectChangeEvent } from './project-event';
import type { QuestionEvent } from './events-bus.service';

/**
 * Sichtbarkeit eines Live-Events für einen Actor — gemeinsam für den
 * WebSocket-Multiplex (main.ts) und die Legacy-SSE-Route (events.controller).
 *
 * Vorher hatte jede Transportschicht ihre eigene Regel, und die SSE-Route
 * nahm `userId` und `projectId` ungeprüft aus dem Query-String (H-13):
 * `?userId=<Opfer>` lieferte dessen persönliche Events, `?projectId=<fremd>`
 * jede Änderung eines fremden Projekts.
 *
 * `userId`/`actor` kommen ausschliesslich aus der Authentifizierung.
 * `actor === undefined` nur bei deaktivierter Auth — dann ist die Instanz
 * ohnehin offen, und es gibt keinen Scope, gegen den man prüfen könnte.
 */
export function isProjectEventVisible(
  event: ProjectChangeEvent,
  userId: string | undefined,
  actor: ActorScope | undefined,
): boolean {
  // Nutzer-gerichtete Events nie an andere Nutzer.
  if (event.userId && event.userId !== userId) return false;
  if (actor && event.projectId !== null && !actorCanAccessProject(actor, String(event.projectId))) {
    return false;
  }
  return true;
}

/**
 * Gerichtete Questions nur an den Adressaten. Broadcast-Questions mit
 * Projektbezug tragen Frage, Optionen und Kontext — dieselbe Projekt-Prüfung
 * wie bei Change-Events, sonst wären sie der Rest des Abhörkanals.
 */
export function isQuestionEventVisible(
  event: QuestionEvent,
  userId: string | undefined,
  actor: ActorScope | undefined,
): boolean {
  if (event.targetUserId && event.targetUserId !== userId) return false;
  if (actor && event.projectId && !actorCanAccessProject(actor, String(event.projectId))) {
    return false;
  }
  return true;
}
