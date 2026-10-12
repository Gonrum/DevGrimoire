import { NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { RequestContext } from '../common/request-context';
import { ResearchTopicDocument } from './schemas/research-topic.schema';

/**
 * Darf der aktuelle Actor dieses Recherche-Thema sehen? (C-13)
 *
 * Ein Thema gehört genau einem Nutzer (`ownerUserId`, in create() aus dem
 * authentifizierten Aufrufer erzwungen). Der Agent recherchiert später in
 * DESSEN RequestContext — wer ein fremdes Thema umschreiben kann, steuert
 * also, wo der Agent eines anderen mit dessen Rechten liest. Bis hierhin
 * prüfte nur create() den Owner; get/update/remove, Runs und Artefakte
 * waren für jeden authentifizierten Nutzer offen.
 *
 * Eine Absage ist bewusst 404 statt 403 — wie ChatService.findById(): ein
 * fremdes Thema soll nicht von einem nicht existierenden unterscheidbar sein.
 *
 * `!actor` bleibt ungegated: der Scheduler (Cron, kein Request) ist ein
 * vertrauenswürdiger interner Aufrufer, und der Agent selbst läuft im
 * Kontext des Owners, besteht die Prüfung also ohnehin.
 */
export function isTopicOwner(topic: Pick<ResearchTopicDocument, 'ownerUserId'>): boolean {
  const actor = RequestContext.getUser();
  if (!actor) return true;
  return topic.ownerUserId?.toString() === actor.userId;
}

export function assertTopicOwner(
  topic: Pick<ResearchTopicDocument, 'ownerUserId'>,
  topicId: string,
): void {
  if (!isTopicOwner(topic)) {
    throw new NotFoundException(`ResearchTopic ${topicId} not found`);
  }
}

/**
 * Variante für Run- und Artefakt-Pfade, die nur eine topicId kennen.
 * Lädt nur `ownerUserId`, nicht das ganze Thema.
 */
export async function assertTopicAccessible(
  topicModel: Model<ResearchTopicDocument>,
  topicId: string | Types.ObjectId,
): Promise<void> {
  if (!RequestContext.getUser()) return;
  const id = topicId.toString();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundException(`ResearchTopic ${id} not found`);
  }
  const topic = await topicModel.findById(id).select('ownerUserId').lean().exec();
  if (!topic) throw new NotFoundException(`ResearchTopic ${id} not found`);
  assertTopicOwner(topic, id);
}
