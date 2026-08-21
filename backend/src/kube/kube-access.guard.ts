import { ForbiddenException } from '@nestjs/common';
import {
  ActorScope, actorCanAccessCustomer, actorCanAccessProject,
} from '../common/permissions';

interface ClusterScope {
  projectId?: unknown;
  customerId?: unknown;
  label?: string;
}

/** Ein Wert, der als ID verwendbar ist (string mit mindestens 1 Zeichen). */
function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

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
 * ignoriert (T-477). Die lesenden Routen aus K2 nutzen sie noch nicht; die
 * globale Regel gehört gemeinsam mit den SSH-Routen entworfen.
 */
export function canAccessCluster(cluster: ClusterScope, actor: ActorScope | undefined): boolean {
  if (!actor) return false;
  if (isValidId(cluster.projectId)) {
    return actorCanAccessProject(actor, cluster.projectId);
  }
  if (isValidId(cluster.customerId)) {
    return actorCanAccessCustomer(actor, cluster.customerId);
  }
  // Ein Cluster ohne Scope verletzt die Schema-Invariante; im Zweifel sperren.
  return false;
}

/**
 * Werfende Variante für die REST-Schicht. Die Meldung nennt bewusst nur das
 * Label, nie die Projekt- oder Kunden-Id: wer den Cluster nicht sehen darf,
 * soll aus der Absage nicht erfahren, wem er gehört.
 */
export function assertClusterAccess(cluster: ClusterScope, actor: ActorScope | undefined): void {
  if (!canAccessCluster(cluster, actor)) {
    throw new ForbiddenException(
      `Kein Zugriff auf den Cluster${cluster.label ? ` "${cluster.label}"` : ''}`,
    );
  }
}
