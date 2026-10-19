import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { AuthService } from '../../auth/auth.service';
import { ApiKeysService } from '../../api-keys/api-keys.service';
import { actorFromApiKey, actorFromUser } from '../../common/actor-scope';
import type { RequestUser } from '../../common/request-context';
import { WorkflowDefinition, WorkflowDefinitionDocument } from '../schemas/workflow-definition.schema';
import { WorkflowRun } from '../schemas/workflow-run.schema';

export interface AccountableActor {
  userId: string;
  /** Gesetzt, wenn der Akteur über einen API-Key verengt ist. */
  apiKeyId?: string;
  actor: RequestUser;
}

interface Candidate {
  userId: string;
  apiKeyId?: string;
}

/**
 * Wem ist ein Workflow-Lauf zuzurechnen?
 *
 * Bisher liefen Nodes ohne `RequestContext` — die `if (actor) assert…`-Prüfungen
 * der Services fielen damit stillschweigend weg, und Nodes mit Außenwirkung
 * (ssh.exec) hätten im Namen von niemandem gehandelt. Dieser Service bestimmt
 * den Nutzer, in dessen Kontext die Engine einen Node ausführt.
 *
 * Reihenfolge der Kandidaten — der erste *vorhandene* gewinnt:
 *   1. `triggeredBy.userId` — wer den Lauf gestartet hat (manuell/Retry)
 *   2. `createdByUserId`
 *   3. nur bei `schedule`/`event`: der Freigebende der **letzten** Approval —
 *      wer die aktuelle Fassung freigegeben hat, verantwortet ihre
 *      automatischen Läufe.
 *
 * Ist der gewählte Kandidat unbekannt oder deaktiviert, gibt es **keinen**
 * Akteur — es wird bewusst nicht auf den nächsten Kandidaten ausgewichen: ein
 * gesperrter Nutzer soll nicht durch einen anderen ersetzt werden, der den Lauf
 * nie angestoßen hat.
 *
 * API-Keys: Kam Start oder Freigabe über einen Key, steht dessen Id am Lauf
 * bzw. an der Approval. Der Akteur ist dann Key ∩ Besitzer
 * (`actorFromApiKey`) — mit `actorFromUser` bekäme ein auf Projekt A
 * verengter Key über den Workflow den vollen Scope seines Besitzers, etwa
 * einen ssh.exec auf dem Server von Projekt B. Ist der Key widerrufen,
 * deaktiviert oder abgelaufen, gibt es keinen Akteur (kein Ausweichen auf den
 * Besitzer).
 */
@Injectable()
export class WorkflowAccountabilityService {
  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    private readonly auth: AuthService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async resolve(
    run: Pick<WorkflowRun, 'triggeredBy' | 'createdByUserId' | 'definitionId'>,
  ): Promise<AccountableActor | null> {
    const candidate = await this.candidate(run);
    // Ungültige Ids nicht bis in `findById` lassen — dort wäre es ein CastError.
    if (!candidate || !isValidObjectId(candidate.userId)) return null;
    const user = await this.auth.findUserById(candidate.userId);
    if (!user || user.active === false) return null;
    if (candidate.apiKeyId === undefined) {
      const actor = actorFromUser(user);
      return { userId: actor.userId, actor };
    }
    const key = await this.apiKeys.findActiveById(candidate.apiKeyId);
    // Ein Key eines anderen Besitzers gehört nicht zu diesem Nutzer — lieber
    // kein Akteur als eine Mischung aus beiden.
    if (!key || key.userId.toString() !== user._id.toString()) return null;
    const actor = actorFromApiKey(key, user);
    return { userId: actor.userId, apiKeyId: candidate.apiKeyId, actor };
  }

  private async candidate(
    run: Pick<WorkflowRun, 'triggeredBy' | 'createdByUserId' | 'definitionId'>,
  ): Promise<Candidate | undefined> {
    if (run.triggeredBy?.userId) {
      return { userId: run.triggeredBy.userId, ...optionalKey(run.triggeredBy.apiKeyId) };
    }
    if (run.createdByUserId) return { userId: run.createdByUserId.toString() };
    const type = run.triggeredBy?.type;
    if (type !== 'schedule' && type !== 'event') return undefined;
    // Kein ungeprüfter Wert in den Filter (Projektregel) — ohne Id keine Abfrage.
    if (!run.definitionId) return undefined;
    const def = await this.definitionModel
      .findById(run.definitionId)
      .select('approvals')
      .lean()
      .exec();
    const last = def?.approvals?.at(-1);
    const userId = last?.approvedByUserId?.toString();
    if (!userId) return undefined;
    return { userId, ...optionalKey(last?.approvedByApiKeyId) };
  }
}

/** `apiKeyId` nur übernehmen, wenn es ein nicht-leerer String ist. */
function optionalKey(apiKeyId: unknown): { apiKeyId?: string } {
  return typeof apiKeyId === 'string' && apiKeyId.length > 0 ? { apiKeyId } : {};
}
