import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Harness, HarnessDocument, HarnessSection } from './schemas/harness.schema';
import { CreateHarnessDto } from './dto/create-harness.dto';
import { UpdateHarnessDto } from './dto/update-harness.dto';
import { HarnessSectionDto } from './dto/harness-section.dto';
import { HarnessLevelInput, HarnessScope, ResolvedHarness } from './harness.types';
import { resolveHarness } from './harness-resolve';
import {
  CustomerProjectLink,
  CustomerProjectLinkDocument,
  CustomerProjectLinkStatus,
} from '../customers/schemas/customer-project-link.schema';
import { Project, ProjectDocument } from '../projects/schemas/project.schema';
import { projectIdFilter } from '../common/project-id-filter';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { isDuplicateKeyError } from '../common/narrow';

export interface HarnessOwner {
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
}

export interface HarnessSummary {
  id: string;
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
  description?: string;
  enabled: boolean;
  sectionCount: number;
  updatedAt?: Date;
}

@Injectable()
export class HarnessService {
  constructor(
    @InjectModel(Harness.name)
    private harnessModel: Model<HarnessDocument>,
    @InjectModel(CustomerProjectLink.name)
    private linkModel: Model<CustomerProjectLinkDocument>,
    @InjectModel(Project.name)
    private projectModel: Model<ProjectDocument>,
    // EventEmitter2 ist global registriert — das bricht die bewusste
    // Modulgrenze nicht auf (kein Import von Projects-/CustomersModule).
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Meldet eine Änderung an einer Harness-Ebene (T-463).
   *
   * Ein Ereignis bedient drei Abnehmer auf einmal: die Activity-Chronik (der
   * Listener dort verbucht **jedes** `PROJECT_CHANGED` generisch), die
   * SSE-Aktualisierung im Frontend (Tab-Zähler) und künftige Interessenten.
   *
   * Die globale Ebene hat weder `projectId` noch `customerId`. Das Ereignis
   * geht trotzdem raus — die Chronik verbucht es dann ohne Owner, und die
   * SSE-Filter routen es niemandem zu. Das ist gewollt: eine Änderung an der
   * obersten Ebene soll nachvollziehbar sein, auch wenn keine Projektansicht
   * sie live nachladen kann.
   */
  private emitChange(
    harness: Pick<HarnessDocument, '_id' | 'scope' | 'projectId' | 'customerId'>,
    action: ProjectChangeEvent['action'],
    summary: string,
  ): void {
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: harness.projectId?.toString() ?? null,
      customerId: harness.customerId?.toString() ?? null,
      entity: 'harness',
      action,
      entityId: harness._id.toString(),
      summary,
    });
  }

  /**
   * Räumt die Harness-Ebene eines gelöschten Projekts ab (T-463).
   *
   * Nur Projekte: Kunden werden über die API **nicht gelöscht, sondern
   * archiviert** (`DELETE /api/customers/:id` → `action: 'updated'`) — es gibt
   * also gar kein Ereignis, an dem ein Kunden-Cleanup hängen könnte, und die
   * Ebene eines archivierten Kunden soll erhalten bleiben: wird er reaktiviert,
   * gelten seine Konventionen wieder.
   *
   * Die Id kommt aus dem Ereignis, nicht aus einer Nachfrage — das Projekt ist
   * zu diesem Zeitpunkt bereits weg.
   */
  @OnEvent(PROJECT_CHANGED)
  async handleCascade(event: ProjectChangeEvent): Promise<void> {
    if (event.action !== 'deleted' || event.entity !== 'project' || !event.entityId) return;
    await this.harnessModel
      .deleteOne({ scope: 'project', projectId: projectIdFilter(event.entityId) })
      .exec();
  }

  /**
   * Resolved harness for a project: `global → customer(s) → project` (T-438).
   *
   * Levels that do not exist are skipped, not merged as empty ones — a project
   * without any harness of its own still gets a valid result (the global level
   * alone, or an empty one if there is none).
   */
  async resolve(projectId: string): Promise<ResolvedHarness> {
    // Vor jeder Abfrage, nicht danach: `_id` ist ObjectId-typisiert, und ein
    // nicht-hexadezimaler Wert lässt Mongoose beim Cast werfen — das käme als
    // HTTP 500 heraus, obwohl der Aufrufer schlicht Unsinn geschickt hat.
    // (`projectIdFilter` reicht einen ungültigen Wert absichtlich roh durch;
    // auf einem String-Feld ist das ein sauberes Nicht-Treffen, auf `_id` nicht.)
    if (!Types.ObjectId.isValid(projectId)) {
      throw new BadRequestException(`'${projectId}' is not a valid project id`);
    }

    const project = await this.projectModel
      .findOne({ _id: projectIdFilter(projectId) })
      .select('_id')
      .lean()
      .exec();
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const levels: HarnessLevelInput[] = [];

    const global = await this.harnessModel.findOne({ scope: 'global' }).exec();
    if (global) levels.push(toLevelInput(global));

    // Eine Abfrage für alle Kundenebenen statt einer pro Kunde; die Reihenfolge
    // kommt anschliessend aus der Verlinkung, nicht aus dem Rückgabe-Ordering
    // von Mongo.
    const customerIds = await this.linkedCustomerIds(projectId);
    if (customerIds.length > 0) {
      const customerLevels = await this.harnessModel
        .find({ scope: 'customer', customerId: { $in: customerIds } })
        .exec();
      const byCustomer = new Map(
        customerLevels.map((level) => [level.customerId?.toString() ?? '', level]),
      );
      for (const customerId of customerIds) {
        const level = byCustomer.get(customerId.toString());
        if (level) levels.push(toLevelInput(level));
      }
    }

    const own = await this.harnessModel
      .findOne({ scope: 'project', projectId: projectIdFilter(projectId) })
      .exec();
    if (own) levels.push(toLevelInput(own));

    return resolveHarness(levels);
  }

  /**
   * Nur die globale Ebene, aufgelöst.
   *
   * Für Aufrufer ohne Projektbezug — `system_instructions_get` ohne
   * `projectId` etwa. Geht bewusst durch denselben Resolver statt die Sections
   * roh zurückzugeben: so ist die Ergebnisform identisch zu `resolve()`
   * (`sections`/`resolvedFrom`/`suppressed`/`markdown`), und der Aufrufer
   * braucht keine Fallunterscheidung.
   */
  async resolveGlobal(): Promise<ResolvedHarness> {
    const global = await this.harnessModel.findOne({ scope: 'global' }).exec();
    return resolveHarness(global ? [toLevelInput(global)] : []);
  }

  /**
   * Customers linked to the project, in link-creation order.
   *
   * The order matters: with two customers contributing the same section key
   * under `append`, the result depends on who comes first. `createdAt` makes
   * that deterministic and explainable ("the customer you linked first sets the
   * tone") instead of leaving it to Mongo's natural order.
   *
   * `archived` links are excluded — an ended engagement should not keep
   * shaping how agents work on the project. `paused` links still contribute:
   * pausing is temporary and the conventions are meant to survive it.
   */
  private async linkedCustomerIds(projectId: string): Promise<Types.ObjectId[]> {
    const links = await this.linkModel
      .find({
        projectId: projectIdFilter(projectId),
        status: { $ne: CustomerProjectLinkStatus.ARCHIVED },
      })
      .sort({ createdAt: 1, _id: 1 })
      .select('customerId')
      .lean()
      .exec();

    // `_id` as the tiebreaker: links created in the same millisecond (bulk
    // import, template application) would otherwise have no defined order.
    const seen = new Set<string>();
    const ids: Types.ObjectId[] = [];
    for (const link of links) {
      const key = link.customerId.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(link.customerId);
    }
    return ids;
  }

  /**
   * Upsert of a single section, keyed by `key` — idempotent: the same input
   * twice leaves the same state.
   *
   * Deliberately a targeted array update instead of writing the whole document
   * back: two concurrent section edits on the same harness must not overwrite
   * each other, which a read-modify-write of `sections` would do.
   */
  async sectionSet(owner: HarnessOwner, dto: HarnessSectionDto): Promise<HarnessDocument> {
    const harness = await this.ensureOwner(owner);
    const section = sectionFromDto(dto);

    const updated = await this.harnessModel
      .findOneAndUpdate(
        { _id: harness._id, 'sections.key': section.key },
        { $set: { 'sections.$': section } },
        { new: true, runValidators: true },
      )
      .exec();
    if (updated) {
      this.emitChange(updated, 'updated', `Harness-Abschnitt '${section.key}' geändert`);
      return updated;
    }

    // Not present yet. `$ne` guards the race against a parallel insert of the
    // same key: the second writer matches nothing and retries through the
    // branch above rather than creating a duplicate.
    const inserted = await this.harnessModel
      .findOneAndUpdate(
        { _id: harness._id, 'sections.key': { $ne: section.key } },
        { $push: { sections: section } },
        { new: true, runValidators: true },
      )
      .exec();
    if (inserted) {
      this.emitChange(inserted, 'updated', `Harness-Abschnitt '${section.key}' angelegt`);
      return inserted;
    }

    const retried = await this.harnessModel
      .findOneAndUpdate(
        { _id: harness._id, 'sections.key': section.key },
        { $set: { 'sections.$': section } },
        { new: true, runValidators: true },
      )
      .exec();
    if (!retried) {
      throw new NotFoundException(`Harness ${harness._id.toString()} not found`);
    }
    this.emitChange(retried, 'updated', `Harness-Abschnitt '${section.key}' geändert`);
    return retried;
  }

  /** Removes a section by key. Unknown key → 404, so a typo is not silent. */
  async sectionDelete(owner: HarnessOwner, key: string): Promise<HarnessDocument> {
    const harness = await this.findByOwner(owner);
    if (!harness) {
      throw new NotFoundException(`No harness for scope '${owner.scope}'`);
    }
    const updated = await this.harnessModel
      .findOneAndUpdate(
        { _id: harness._id, 'sections.key': key },
        { $pull: { sections: { key } } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(`Section '${key}' not found in harness ${harness._id.toString()}`);
    }
    this.emitChange(updated, 'updated', `Harness-Abschnitt '${key}' entfernt`);
    return updated;
  }

  /**
   * The harness for a level, created on first write.
   *
   * Without this, setting a section would require the caller to create the
   * level first — three round trips for what is conceptually one edit, and a
   * race if two callers create it at the same time (the partial unique index
   * would reject the second).
   */
  async ensureOwner(owner: HarnessOwner): Promise<HarnessDocument> {
    const existing = await this.findByOwner(owner);
    if (existing) return existing;

    const created: Partial<Harness> = { scope: owner.scope, enabled: true, sections: [] };
    if (owner.scope === 'project') created.projectId = new Types.ObjectId(owner.projectId);
    if (owner.scope === 'customer') created.customerId = new Types.ObjectId(owner.customerId);

    try {
      return await this.harnessModel.create(created);
    } catch (err) {
      // Lost the race against a parallel create — the partial unique index did
      // its job, and the other writer's document is the one we want.
      if (isDuplicateKeyError(err)) {
        const raced = await this.findByOwner(owner);
        if (raced) return raced;
      }
      throw err;
    }
  }

  async create(dto: CreateHarnessDto): Promise<HarnessDocument> {
    const harness = await this.harnessModel.create(dto);
    this.emitChange(harness, 'created', `Harness-Ebene '${harness.scope}' angelegt`);
    return harness;
  }

  async findById(id: string): Promise<HarnessDocument | null> {
    return this.harnessModel.findById(id).exec();
  }

  async findByOwner(owner: HarnessOwner): Promise<HarnessDocument | null> {
    return this.harnessModel.findOne(this.ownerFilter(owner)).exec();
  }

  async update(id: string, dto: UpdateHarnessDto): Promise<HarnessDocument> {
    const harness = await this.harnessModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true, runValidators: true })
      .exec();
    if (!harness) {
      throw new NotFoundException(`Harness ${id} not found`);
    }
    this.emitChange(harness, 'updated', `Harness-Ebene '${harness.scope}' geändert`);
    return harness;
  }

  async remove(id: string): Promise<void> {
    const result = await this.harnessModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Harness ${id} not found`);
    }
    this.emitChange(result, 'deleted', `Harness-Ebene '${result.scope}' gelöscht`);
  }

  /** Metadata only — the resolved content is served by `resolve()` (T-438). */
  async list(scope?: HarnessScope): Promise<HarnessSummary[]> {
    const filter: FilterQuery<HarnessDocument> = scope ? { scope } : {};
    const harnesses = await this.harnessModel.find(filter).sort({ scope: 1 }).exec();
    return harnesses.map((harness) => ({
      id: harness._id.toString(),
      scope: harness.scope,
      projectId: harness.projectId?.toString(),
      customerId: harness.customerId?.toString(),
      description: harness.description,
      enabled: harness.enabled,
      sectionCount: harness.sections?.length ?? 0,
      updatedAt: harness.updatedAt,
    }));
  }

  /**
   * Mirrors the DTO rule at the persistence boundary: callers that bypass the
   * controller (MCP handlers, migration script) get the same guarantee.
   */
  private ownerFilter(owner: HarnessOwner): FilterQuery<HarnessDocument> {
    switch (owner.scope) {
      case 'global':
        return { scope: 'global' };
      case 'project':
        if (!owner.projectId) {
          throw new BadRequestException("projectId is required for scope 'project'");
        }
        // `projectIdFilter` statt des rohen Strings — empirisch nötig, nicht
        // vorsorglich: mit `{ projectId: '69c1…' }` fand `findOne` ein Dokument
        // **nicht**, dessen `projectId` als ObjectId mit exakt diesem Wert in
        // Mongo liegt (direkt in der DB gegengeprüft). Mongoose castet den
        // Query-Wert hier nicht auf den Schematyp. `resolve()` fiel nicht auf,
        // weil es diesen Helfer von Anfang an benutzt hat.
        return { scope: 'project', projectId: projectIdFilter(owner.projectId) };
      case 'customer':
        if (!owner.customerId) {
          throw new BadRequestException("customerId is required for scope 'customer'");
        }
        // Gleiche Klasse; der Helfer heisst nach seinem ersten Anwendungsfall,
        // baut aber nur `$in: [string, ObjectId]`.
        return { scope: 'customer', customerId: projectIdFilter(owner.customerId) };
      default:
        throw new BadRequestException(`Unknown harness scope '${String(owner.scope)}'`);
    }
  }
}

/**
 * Persisted level → resolver input.
 *
 * The resolver is deliberately free of mongoose types, so this is where the
 * document is flattened. `toObject()` and not `{...doc}`: spreading a mongoose
 * document yields `{$__, _doc}` — the schema fields are prototype getters and
 * would be lost.
 */
function toLevelInput(harness: HarnessDocument): HarnessLevelInput {
  return {
    scope: harness.scope,
    projectId: harness.projectId?.toString(),
    customerId: harness.customerId?.toString(),
    enabled: harness.enabled,
    sections: harness.sections.map((section) => ({
      key: section.key,
      kind: section.kind,
      title: section.title,
      body: section.body,
      payload: section.payload,
      mergeStrategy: section.mergeStrategy,
      order: section.order,
      enabled: section.enabled,
    })),
  };
}

/**
 * DTO → stored section, with the defaults applied explicitly.
 *
 * Explicit because `$set: {'sections.$': section}` replaces the whole element:
 * a field left undefined would be dropped rather than keeping its previous
 * value, and mongoose's schema defaults do not fill positional updates.
 */
function sectionFromDto(dto: HarnessSectionDto): HarnessSection {
  return {
    key: dto.key,
    kind: dto.kind ?? 'prose',
    title: dto.title ?? '',
    body: dto.body ?? '',
    payload: dto.payload,
    mergeStrategy: dto.mergeStrategy ?? 'replace',
    order: dto.order ?? 0,
    enabled: dto.enabled ?? true,
  };
}
