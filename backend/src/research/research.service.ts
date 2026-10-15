import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import { Research, ResearchDocument } from './schemas/research.schema';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { actorCanAccessCustomer, actorCanAccessProject } from '../common/permissions';
import { RequestContext } from '../common/request-context';
import { isRecord, isUnknownArray, toPlainDoc, type PlainDoc } from '../common/tool-args';
import { assertMoveTarget, canReadResearch, visibleResearchFilter } from './research-access';
import { ResearchLiveService } from './research-live.service';
import { ResearchStepsService } from './research-steps.service';
import type { ResearchStatus } from './research-types';

/**
 * Listen und Suche liefern weder hochgeladenen Dateitext noch Laufinterna
 * (Teilaufträge, Quellenregister) — die gehören in die Detailansicht.
 */
export const RESEARCH_LIST_PROJECTION = { 'files.text': 0, tasks: 0, sourceList: 0 } as const;

const ACTIVE: ResearchStatus[] = ['queued', 'running'];

/** Detail für Werkzeuge (MCP `research_get`): Dateien nur mit Nummer und Name, ohne Text. */
export function researchDetailForTool(doc: unknown): PlainDoc {
  const obj = toPlainDoc(doc);
  if (isUnknownArray(obj.files)) {
    obj.files = obj.files.map((f) => (isRecord(f) ? { n: f.n, name: f.name } : f));
  }
  return obj;
}

@Injectable()
export class ResearchService {
  constructor(
    @InjectModel(Research.name)
    private researchModel: Model<ResearchDocument>,
    private eventEmitter: EventEmitter2,
    private readonly live: ResearchLiveService,
    private readonly steps: ResearchStepsService,
  ) {}

  async create(dto: CreateResearchDto): Promise<ResearchDocument> {
    assertMoveTarget(RequestContext.getUser(), dto);
    return this.insert(dto);
  }

  /**
   * Nur für den Projektimport: das Zielprojekt ist frisch angelegt und steht
   * (noch) nicht in der Allowlist des Importierenden. Genau-ein-Ziel bleibt
   * geprüft, der Scope nicht.
   */
  async createForImport(dto: CreateResearchDto): Promise<ResearchDocument> {
    assertMoveTarget(undefined, dto);
    return this.insert(dto);
  }

  private async insert(dto: CreateResearchDto): Promise<ResearchDocument> {
    const actor = RequestContext.getUser();
    const ownerUserId = actor && Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null;
    const entry = await this.researchModel.create({ ...dto, status: 'done', ownerUserId });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId?.toString() || null,
      customerId: entry.customerId?.toString() || null,
      entity: 'research',
      action: 'created',
      entityId: entry._id.toString(),
      summary: `Recherche "${entry.title}" gespeichert`,
    });
    return entry;
  }

  async findByProject(projectId: string): Promise<ResearchDocument[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessProject(actor, projectId)) throw new ForbiddenException('Kein Zugriff auf das Projekt');
    return this.researchModel.find({ projectId: projectIdFilter(projectId) }, RESEARCH_LIST_PROJECTION).sort({ updatedAt: -1 }).exec();
  }

  async findByCustomer(customerId: string): Promise<ResearchDocument[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessCustomer(actor, customerId)) throw new ForbiddenException('Kein Zugriff auf den Kunden');
    return this.researchModel.find({ customerId: projectIdFilter(customerId) }, RESEARCH_LIST_PROJECTION).sort({ updatedAt: -1 }).exec();
  }

  async search(query: string, projectId?: string, customerId?: string): Promise<ResearchDocument[]> {
    const filter: FilterQuery<Research> = { $text: { $search: query } };
    if (projectId) filter.projectId = projectIdFilter(projectId);
    if (customerId) filter.customerId = projectIdFilter(customerId);
    const visible = visibleResearchFilter(RequestContext.getUser());
    const scoped: FilterQuery<Research> = Object.keys(visible).length > 0 ? { $and: [filter, visible] } : filter;
    return this.researchModel
      .find(scoped, { ...RESEARCH_LIST_PROJECTION, score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .exec();
  }

  async findById(id: string): Promise<ResearchDocument> {
    const entry = await this.researchModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Research ${id} not found`);
    return entry;
  }

  /** Wie findById, aber 404 auch bei fehlendem Recht (keine Existenz-Auskunft). */
  async findVisibleById(id: string): Promise<ResearchDocument> {
    const entry = await this.findById(id);
    if (!canReadResearch(RequestContext.getUser(), entry)) {
      throw new NotFoundException(`Research ${id} not found`);
    }
    return entry;
  }

  /** Persönlicher Speicher: nicht zugeordnete Recherchen des Actors (Admin: alle). */
  async listMine(): Promise<ResearchDocument[]> {
    const actor = RequestContext.getUser();
    const filter: FilterQuery<Research> = { projectId: null, customerId: null };
    if (actor && actor.role !== 'admin') {
      if (!Types.ObjectId.isValid(actor.userId)) return [];
      filter.ownerUserId = new Types.ObjectId(actor.userId);
    }
    return this.researchModel.find(filter, RESEARCH_LIST_PROJECTION).sort({ createdAt: -1 }).exec();
  }

  async update(id: string, dto: UpdateResearchDto): Promise<ResearchDocument> {
    const current = await this.findVisibleById(id);
    // Ein laufender Lauf überschriebe die Änderung beim Abschluss (oder umgekehrt).
    if (ACTIVE.includes(current.status)) throw new ConflictException(`Recherche ist ${current.status} – erst abwarten oder abbrechen`);
    // Statusgeschützt gegen den Start zwischen Lesen und Schreiben.
    const entry = await this.researchModel
      .findOneAndUpdate({ _id: current._id, status: { $nin: ACTIVE } }, dto, { new: true })
      .exec();
    if (!entry) throw new ConflictException('Recherche wurde inzwischen gestartet');
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId?.toString() || null,
      customerId: entry.customerId?.toString() || null,
      entity: 'research',
      action: 'updated',
      entityId: id,
      summary: `Recherche "${entry.title}" aktualisiert`,
    });
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.findVisibleById(id);
    const result = await this.researchModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Research ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId?.toString() || null,
      customerId: result.customerId?.toString() || null,
      entity: 'research',
      action: 'deleted',
      entityId: id,
      summary: `Recherche "${result.title}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.removeWhere({ projectId: new Types.ObjectId(projectId) });
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.removeWhere({ customerId: new Types.ObjectId(customerId) });
  }

  /**
   * Kaskade: aktive Läufe zuerst stoppen (Flag + Abbruchsignal; der Runner findet
   * das Dokument danach nicht mehr und endet still), Schritte entfernen, dann löschen.
   */
  private async removeWhere(filter: FilterQuery<Research>): Promise<void> {
    const rows = await this.researchModel.find(filter).select('_id status').lean<Array<{ _id: Types.ObjectId; status?: ResearchStatus }>>().exec();
    const active = rows.filter((r) => r.status !== undefined && ACTIVE.includes(r.status)).map((r) => r._id);
    if (active.length > 0) {
      await this.researchModel.updateMany({ _id: { $in: active } }, { $set: { cancelRequested: true } }).exec();
      for (const id of active) this.live.abort(id.toString());
    }
    for (const r of rows) await this.steps.removeFor(r._id.toString());
    await this.researchModel.deleteMany(filter).exec();
  }
}
