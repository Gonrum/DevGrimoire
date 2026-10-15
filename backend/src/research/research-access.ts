import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { FilterQuery } from 'mongoose';
import { Types } from 'mongoose';
import { actorCanAccessCustomer, actorCanAccessProject } from '../common/permissions';
import type { RequestUser } from '../common/request-context';
import type { Research } from './schemas/research.schema';

export interface ResearchAccessDoc {
  ownerUserId?: Types.ObjectId | string | null;
  projectId?: Types.ObjectId | string | null;
  customerId?: Types.ObjectId | string | null;
}

const idOf = (v: Types.ObjectId | string | null | undefined): string | null => (v ? String(v) : null);

export function isAssigned(doc: ResearchAccessDoc): boolean {
  return !!idOf(doc.projectId) || !!idOf(doc.customerId);
}

/**
 * Persönlich (nicht zugeordnet): nur Besitzer, Admin alles. Zugeordnet: der
 * Scope des Ziels. Ohne Actor erlaubt — dieselbe Ausfallrichtung wie die
 * übrigen Module bei deaktivierter Auth.
 */
export function canReadResearch(actor: RequestUser | undefined, doc: ResearchAccessDoc): boolean {
  if (!actor) return true;
  const projectId = idOf(doc.projectId);
  const customerId = idOf(doc.customerId);
  // Beide Achsen gesetzt (Alt-/Replikationsbestand): Zugriff auf BEIDE nötig.
  if (projectId || customerId) {
    return (!projectId || actorCanAccessProject(actor, projectId))
      && (!customerId || actorCanAccessCustomer(actor, customerId));
  }
  if (actor.role === 'admin') return true;
  return idOf(doc.ownerUserId) === actor.userId;
}

export const canControlResearch = canReadResearch;

/** Ids als ObjectId und String: der Bestand speichert beides (siehe projectIdFilter). */
function bothForms(ids: readonly string[] | undefined): Array<string | Types.ObjectId> {
  const out: Array<string | Types.ObjectId> = [];
  for (const raw of ids ?? []) {
    const id = String(raw);
    if (!Types.ObjectId.isValid(id)) continue;
    out.push(id, new Types.ObjectId(id));
  }
  return out;
}

/** Filter für Listen. Werte stammen aus dem authentifizierten Actor, nicht aus der Anfrage. */
export function visibleResearchFilter(actor: RequestUser | undefined): FilterQuery<Research> {
  if (!actor) return {};
  const unassigned = { projectId: null, customerId: null };
  let personal: FilterQuery<Research>;
  if (actor.role === 'admin') personal = unassigned;
  else if (Types.ObjectId.isValid(actor.userId)) personal = { ...unassigned, ownerUserId: new Types.ObjectId(actor.userId) };
  else personal = { _id: { $in: [] } }; // unbrauchbare userId trifft nichts
  // Pro Achse: ungesetzt passt immer, gesetzt nur mit Zugriff. Beide Achsen
  // müssen passen (Alt-/Replikationsdokumente können beide tragen).
  const axis = (
    field: 'projectId' | 'customerId',
    mode: string,
    ids: readonly string[] | undefined,
  ): FilterQuery<Research> => {
    if (mode === 'all') return {};
    if (mode === 'allowlist') return { $or: [{ [field]: null }, { [field]: { $in: bothForms(ids) } }] };
    return { [field]: null };
  };
  const assigned: FilterQuery<Research> = {
    $and: [
      { $or: [{ projectId: { $ne: null } }, { customerId: { $ne: null } }] },
      axis('projectId', actor.projectScopeMode ?? 'all', actor.allowedProjectIds),
      axis('customerId', actor.customerScopeMode ?? 'all', actor.allowedCustomerIds),
    ],
  };
  return { $or: [personal, assigned] };
}

export function assertMoveTarget(actor: RequestUser | undefined, target: { projectId?: string; customerId?: string }): void {
  const hasP = !!target.projectId;
  const hasC = !!target.customerId;
  if (hasP === hasC) throw new BadRequestException('Genau ein Ziel angeben: projectId oder customerId');
  const id = (hasP ? target.projectId : target.customerId) ?? '';
  if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Ungültige Ziel-Id');
  if (!actor) return;
  const ok = hasP ? actorCanAccessProject(actor, id) : actorCanAccessCustomer(actor, id);
  if (!ok) throw new ForbiddenException('Kein Zugriff auf das Ziel');
}
