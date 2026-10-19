import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { AuthService } from '../../auth/auth.service';
import { actorFromUser } from '../../common/actor-scope';
import type { RequestUser } from '../../common/request-context';
import { WorkflowDefinition, WorkflowDefinitionDocument } from '../schemas/workflow-definition.schema';
import { WorkflowRun } from '../schemas/workflow-run.schema';

export interface AccountableActor {
  userId: string;
  actor: RequestUser;
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
 */
@Injectable()
export class WorkflowAccountabilityService {
  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    private readonly auth: AuthService,
  ) {}

  async resolve(
    run: Pick<WorkflowRun, 'triggeredBy' | 'createdByUserId' | 'definitionId'>,
  ): Promise<AccountableActor | null> {
    const userId = await this.candidateUserId(run);
    // Ungültige Ids nicht bis in `findById` lassen — dort wäre es ein CastError.
    if (!userId || !isValidObjectId(userId)) return null;
    const user = await this.auth.findUserById(userId);
    if (!user || user.active === false) return null;
    const actor = actorFromUser(user);
    return { userId: actor.userId, actor };
  }

  private async candidateUserId(
    run: Pick<WorkflowRun, 'triggeredBy' | 'createdByUserId' | 'definitionId'>,
  ): Promise<string | undefined> {
    if (run.triggeredBy?.userId) return run.triggeredBy.userId;
    if (run.createdByUserId) return run.createdByUserId.toString();
    const type = run.triggeredBy?.type;
    if (type !== 'schedule' && type !== 'event') return undefined;
    // Kein ungeprüfter Wert in den Filter (Projektregel) — ohne Id keine Abfrage.
    if (!run.definitionId) return undefined;
    const def = await this.definitionModel.findById(run.definitionId).select('approvals').lean().exec();
    const last = def?.approvals?.at(-1);
    return last?.approvedByUserId?.toString();
  }
}
