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
  if (projectId) return actorCanAccessProject(actor, projectId);
  if (customerId) return actorCanAccessCustomer(actor, customerId);
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
  const personal: FilterQuery<Research> = actor.role === 'admin'
    ? unassigned
    : { ...unassigned, ownerUserId: Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null };
  const parts: FilterQuery<Research>[] = [personal];
  const pMode = actor.projectScopeMode ?? 'all';
  if (pMode === 'all') parts.push({ projectId: { $ne: null } });
  else if (pMode === 'allowlist') {
    parts.push({ projectId: { $in: bothForms(actor.allowedProjectIds) } });
  }
  const cMode = actor.customerScopeMode ?? 'all';
  if (cMode === 'all') parts.push({ customerId: { $ne: null } });
  else if (cMode === 'allowlist') {
    parts.push({ customerId: { $in: bothForms(actor.allowedCustomerIds) } });
  }
  return { $or: parts };
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
