import { ForbiddenException } from '@nestjs/common';
import {
  ActorScope, actorCanAccessCustomer, actorCanAccessProject,
} from '../common/permissions';
import { SshConnectionDocument } from './schemas/ssh-connection.schema';

/**
 * Darf dieser Actor diese SSH-Verbindung sehen?
 *
 * Spiegelt `kube/kube-access.guard.ts` absichtlich Feld für Feld: eine
 * SSH-Verbindung trägt genau eines von projectId / customerId (Schema-Invariante,
 * per pre-save erzwungen), also entscheidet der jeweils passende Helfer — und
 * nur der. Ein Actor mit weitem Projekt-Scope erhält damit keinen Zugriff auf
 * eine kunden-gebundene Verbindung.
 *
 * Warum das überhaupt nötig war: `grep -rn "RequestContext|actorCan|
 * ForbiddenException" backend/src/ssh/` lieferte NULL Treffer. Das gesamte
 * Modul kannte das Scope-Modell der Anwendung nicht, während projects, todos,
 * knowledge, secrets, customers, attachments und kube es durchziehen. Damit
 * war jede SSH-Route über eine erratene 24-Hex-Id erreichbar — inklusive
 * `POST /:id/upload` (beliebige Datei an beliebigen remotePath, z. B.
 * ~/.ssh/authorized_keys) und `wss://…/api/ssh/:id/terminal` (interaktive
 * Shell auf jedem konfigurierten Produktionsserver).
 *
 * Zusammen mit der ungegateden `host`-Änderung per PATCH und dem ungegateden
 * `accept-fingerprint` ergab das eine vollständige Kette zum Klartext-Diebstahl
 * der SSH-Private-Keys und Passwörter: host auf einen Angreifer-Rechner
 * biegen, dessen Fingerprint über `POST /:id/test` abfragen (die Antwort
 * liefert ihn), per `accept-fingerprint` hinterlegen, und beim zweiten `test`
 * authentifiziert sich das Backend mit den entschlüsselten Credentials gegen
 * den Angreifer-Host.
 *
 * `!actor → false` ist fail-closed auf Guard-Ebene; die Aufrufer im Service
 * wenden die dokumentierte Projekt-Konvention an (`if (actor) assert…`), weil
 * ein fehlender Actor ein vertrauenswürdiger interner Aufrufer ist.
 */
export function canAccessConnection(
  connection: Pick<SshConnectionDocument, 'projectId' | 'customerId' | 'label'>,
  actor: ActorScope | undefined,
): boolean {
  if (!actor) return false;
  if (connection.projectId) {
    return actorCanAccessProject(actor, String(connection.projectId));
  }
  if (connection.customerId) {
    return actorCanAccessCustomer(actor, String(connection.customerId));
  }
  // Eine Verbindung ohne Scope verletzt die Schema-Invariante; im Zweifel sperren.
  return false;
}

/**
 * Werfende Variante. Die Meldung nennt bewusst nur das Label, nie die Projekt-
 * oder Kunden-Id: wer die Verbindung nicht sehen darf, soll aus der Absage
 * nicht erfahren, wem sie gehört.
 */
export function assertConnectionAccess(
  connection: Pick<SshConnectionDocument, 'projectId' | 'customerId' | 'label'>,
  actor: ActorScope | undefined,
): void {
  if (!canAccessConnection(connection, actor)) {
    throw new ForbiddenException(
      `Kein Zugriff auf die SSH-Verbindung${connection.label ? ` "${connection.label}"` : ''}`,
    );
  }
}
