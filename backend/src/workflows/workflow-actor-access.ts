import { ForbiddenException } from '@nestjs/common';
import { ActorScope, actorCanAccessCustomer, actorCanAccessProject } from '../common/permissions';

interface IdLike {
  toString(): string;
}

/**
 * Darf der Request-Akteur einen Workflow dieses Projekts/Kunden starten,
 * erneut starten, freigeben oder testen?
 *
 * Ohne diese Prüfung reichte jeder authentifizierte Aufrufer: ein auf Projekt A
 * verengter API-Key konnte einen Workflow in Projekt B aktivieren und starten —
 * und dessen Nodes liefen dann im Namen des Key-Besitzers. Die Prüfung gilt
 * nur mit Akteur; ohne Akteur ist der Aufrufer intern (Scheduler,
 * Event-Listener) und vertrauenswürdig — dieselbe Konvention wie in den
 * übrigen Services. System-Workflows haben keinen Besitzer und bleiben offen.
 */
export function assertActorCanAccessWorkflow(
  actor: ActorScope | undefined,
  owner: { projectId?: IdLike | null; customerId?: IdLike | null },
): void {
  if (!actor) return;
  const projectId = owner.projectId?.toString();
  const customerId = owner.customerId?.toString();
  if (projectId && !actorCanAccessProject(actor, projectId)) {
    throw new ForbiddenException('Kein Zugriff auf das Projekt dieses Workflows');
  }
  if (customerId && !actorCanAccessCustomer(actor, customerId)) {
    throw new ForbiddenException('Kein Zugriff auf den Kunden dieses Workflows');
  }
}

/**
 * Write access (create, edit, enable, delete) to a workflow definition.
 *
 * Same owner check as above, plus: a system workflow has no owner, runs
 * instance-wide and its nodes act across every project — so creating or
 * changing one requires the admin role and unrestricted scope. Otherwise any
 * narrowed user could plant a scheduled system workflow that reads foreign
 * projects.
 */
export function assertActorCanWriteWorkflow(
  actor: ActorScope | undefined,
  owner: { projectId?: IdLike | null; customerId?: IdLike | null },
): void {
  if (!actor) return;
  assertActorCanAccessWorkflow(actor, owner);
  if (owner.projectId?.toString() || owner.customerId?.toString()) return;
  if (actor.role !== 'admin') {
    throw new ForbiddenException('System workflows require the admin role');
  }
  if ((actor.projectScopeMode ?? 'all') !== 'all' || (actor.customerScopeMode ?? 'all') !== 'all') {
    throw new ForbiddenException('System workflows require unrestricted project and customer scope');
  }
}
