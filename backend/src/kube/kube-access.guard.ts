import { ForbiddenException } from '@nestjs/common';
import {
  ActorScope, actorCanAccessCustomer, actorCanAccessProject,
} from '../common/permissions';
import { KubeClusterDocument } from './schemas/kube-cluster.schema';

/**
 * Darf dieser Actor diesen Cluster sehen?
 *
 * Ein Cluster trägt genau eines von projectId / customerId (Schema-Invariante
 * aus K1), deshalb entscheidet der jeweils passende Helfer — und nur der. Ein
 * Actor mit weitem Projekt-Scope erhält damit keinen Zugriff auf einen
 * kunden-gebundenen Cluster.
 *
 * Beide Helfer sind bei den Default-Modi ('all') erlaubend. Diese Funktion
 * sperrt also nichts zu, was heute offen ist — sie respektiert die
 * Einschränkungen, die das System bereits kennt und die das Kube-Modul bislang
 * ignoriert hat (T-477).
 *
 * Aufgerufen wird sie aus `KubeClustersService.findById()`, `findBySlug()` und
 * `visibleToActor()` — also an der einen Stelle, über die jede Cluster-Route
 * läuft, statt an jeder Route einzeln. Das SSH-Modul spiegelt das in
 * `ssh/ssh-access.guard.ts`.
 */
export function canAccessCluster(
  cluster: Pick<KubeClusterDocument, 'projectId' | 'customerId' | 'label'>,
  actor: ActorScope | undefined,
): boolean {
  if (!actor) return false;
  if (cluster.projectId) {
    return actorCanAccessProject(actor, String(cluster.projectId));
  }
  if (cluster.customerId) {
    return actorCanAccessCustomer(actor, String(cluster.customerId));
  }
  // Ein Cluster ohne Scope verletzt die Schema-Invariante; im Zweifel sperren.
  return false;
}

/**
 * Werfende Variante für die REST-Schicht. Die Meldung nennt bewusst nur das
 * Label, nie die Projekt- oder Kunden-Id: wer den Cluster nicht sehen darf,
 * soll aus der Absage nicht erfahren, wem er gehört.
 */
export function assertClusterAccess(
  cluster: Pick<KubeClusterDocument, 'projectId' | 'customerId' | 'label'>,
  actor: ActorScope | undefined,
): void {
  if (!canAccessCluster(cluster, actor)) {
    throw new ForbiddenException(
      `Kein Zugriff auf den Cluster${cluster.label ? ` "${cluster.label}"` : ''}`,
    );
  }
}
