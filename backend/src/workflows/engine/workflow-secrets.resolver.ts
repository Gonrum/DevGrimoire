import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Secret, SecretDocument } from '../../secrets/schemas/secret.schema';
import { SecretsService } from '../../secrets/secrets.service';
import { RequestContext } from '../../common/request-context';
import { WorkflowScopeGuard } from '../workflow-scope.guard';
import { WorkflowRun } from '../schemas/workflow-run.schema';
import { findSecretKeys } from '../nodes/template-resolver';
import { AccountableActor } from './workflow-accountability.service';

/** Ein für Workflows verfügbares Secret — nur Metadaten, nie der Wert. */
export interface WorkflowSecretInfo {
  key: string;
  description?: string;
  origin: 'project' | 'customer';
  ownerId: string;
}

type RunOwner = Pick<WorkflowRun, 'projectId' | 'customerId'>;

interface SecretCandidate {
  _id: Types.ObjectId;
  key: string;
  description?: string;
  projectId?: Types.ObjectId;
  customerId?: Types.ObjectId;
}

function toObjectIds(ids: string[]): Types.ObjectId[] {
  return ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
}

function ownerFromStrings(owner: { projectId?: string; customerId?: string }): RunOwner {
  return {
    projectId: owner.projectId && Types.ObjectId.isValid(owner.projectId) ? new Types.ObjectId(owner.projectId) : undefined,
    customerId:
      owner.customerId && Types.ObjectId.isValid(owner.customerId) ? new Types.ObjectId(owner.customerId) : undefined,
  };
}

/**
 * Löst `{{secrets.KEY}}` für Workflow-Läufe auf.
 *
 * Verfügbar sind nur „lose" Secrets: ohne Umgebung (`environmentId: null`)
 * und nicht an eine SSH-Verbindung oder einen Kube-Cluster gebunden — die
 * gehören ihrem Besitzer und sollen nicht über einen Befehl abrufbar sein.
 * Herkunft ist das Projekt/der Kunde des Laufs, beim Projekt-Workflow
 * zusätzlich die verlinkten Kunden (`WorkflowScopeGuard.allowedOwners`).
 * Bei gleichem KEY gewinnt das Projekt.
 *
 * Der Wert wird ausschließlich über `SecretsService.findById` im
 * RequestContext des zurechenbaren Akteurs gelesen: darf der Akteur das
 * Secret nicht lesen, ist es für den Lauf schlicht nicht vorhanden.
 */
@Injectable()
export class WorkflowSecretsResolver {
  constructor(
    @InjectModel(Secret.name) private readonly secretModel: Model<SecretDocument>,
    private readonly secrets: SecretsService,
    private readonly scope: WorkflowScopeGuard,
  ) {}

  /** Metadaten, Projekt vor Kunden, je KEY einmal. */
  async available(owner: { projectId?: string; customerId?: string }): Promise<WorkflowSecretInfo[]> {
    const winners = await this.winners(ownerFromStrings(owner));
    return [...winners.values()].map((s) => ({
      key: s.key,
      ...(s.description ? { description: s.description } : {}),
      origin: s.projectId ? 'project' : 'customer',
      ownerId: (s.projectId ?? s.customerId ?? '').toString(),
    }));
  }

  async resolve(
    run: RunOwner,
    keys: string[],
    actor: AccountableActor | null,
  ): Promise<{ values: Record<string, string>; missing: string[] }> {
    const wanted = [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))];
    if (wanted.length === 0) return { values: {}, missing: [] };
    // Ohne Akteur nie lesen: `findById` ohne RequestContext gilt als interner,
    // vertrauenswürdiger Aufruf und prüfte gar nichts.
    if (!actor) return { values: {}, missing: wanted };

    const winners = await this.winners(run, wanted);
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of wanted) {
      const candidate = winners.get(key);
      if (!candidate) {
        missing.push(key);
        continue;
      }
      try {
        const secret = await RequestContext.run(actor.actor, undefined, () =>
          this.secrets.findById(candidate._id.toString()),
        );
        values[key] = secret.value;
      } catch {
        // ForbiddenException, gelöscht, nicht entschlüsselbar: für den Lauf
        // fehlt das Secret — der Preflight meldet `template_unresolved`.
        missing.push(key);
      }
    }
    return { values, missing };
  }

  /** Je KEY das maßgebliche Secret: Projekt vor Kunden, Kunden in Link-Reihenfolge. */
  private async winners(run: RunOwner, keys?: string[]): Promise<Map<string, SecretCandidate>> {
    const owners = await this.scope.allowedOwners(run);
    // Ein Kunden-Workflow erreicht über `allowedOwners` auch die verlinkten
    // Projekte — deren Secrets gehören ihm aber nicht.
    const projectIds = toObjectIds(run.projectId ? owners.projectIds : []);
    const customerIds = toObjectIds(owners.customerIds);
    const result = new Map<string, SecretCandidate>();
    // Leere Listen: keine Abfrage — `$in: []` wäre zwar harmlos, aber ein
    // Lauf ohne Besitzer (System) hat schlicht keine Secrets.
    if (projectIds.length === 0 && customerIds.length === 0) return result;

    const or: Record<string, unknown>[] = [];
    if (projectIds.length > 0) or.push({ projectId: { $in: projectIds } });
    if (customerIds.length > 0) or.push({ customerId: { $in: customerIds } });
    const docs = await this.secretModel
      .find({
        $or: or,
        environmentId: null,
        ownedBySshConnectionId: { $exists: false },
        ownedByKubeClusterId: { $exists: false },
        ...(keys ? { key: { $in: keys } } : {}),
      })
      .lean<SecretCandidate[]>()
      .exec();

    const projectRank = projectIds.map(String);
    const customerRank = customerIds.map(String);
    // -1: Treffer passt zu keinem erlaubten Besitzer (kann nur eine fehlerhafte
    // Abfrage liefern) — dann lieber weglassen.
    const rank = (s: SecretCandidate): number => {
      if (s.projectId) return projectRank.indexOf(s.projectId.toString());
      if (s.customerId) {
        const i = customerRank.indexOf(s.customerId.toString());
        return i < 0 ? -1 : projectRank.length + i;
      }
      return -1;
    };
    const sorted = docs
      .filter((s) => typeof s.key === 'string' && rank(s) >= 0)
      .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
    for (const s of sorted) if (!result.has(s.key)) result.set(s.key, s);
    return result;
  }
}

/**
 * Aktivierungsprüfung: `{{secrets.…}}` nur in Node-Typen, die Secrets
 * einsetzen dürfen. Zur Laufzeit scheitert so ein Node ohnehin mit
 * `secret_not_allowed` — die Aktivierung soll es vorher sagen.
 */
export function secretPlaceholderIssues(
  nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>,
  allows: (type: string) => boolean,
): string[] {
  const issues: string[] = [];
  for (const node of nodes) {
    const keys = findSecretKeys(node.config ?? {});
    if (keys.length === 0 || allows(node.type)) continue;
    issues.push(`node "${node.id}" (${node.type}): Secrets sind hier nicht erlaubt (${keys.join(', ')})`);
  }
  return issues;
}
