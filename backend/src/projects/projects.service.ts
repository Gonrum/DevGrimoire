import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Project, ProjectDocument } from './schemas/project.schema';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { RequestContext } from '../common/request-context';
import { actorCanAccessProject } from '../common/permissions';
import { buildScopeFilter } from '../common/scope';
import {
  CustomerProjectLink,
  CustomerProjectLinkDocument,
} from '../customers/schemas/customer-project-link.schema';
import { RagService } from '../rag/rag.service';

export interface SemanticSearchResult {
  projects: Array<{
    _id: string;
    name: string;
    description?: string;
    techStack: string[];
    tags: string[];
    active: boolean;
    favorite: boolean;
    score: number;
    createdAt: string;
    updatedAt: string;
  }>;
  relatedHits: Array<{
    entity: string;
    id: string;
    title: string;
    projectId: string;
    score: number;
  }>;
}

@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>,
    @InjectModel(CustomerProjectLink.name)
    private customerProjectLinkModel: Model<CustomerProjectLinkDocument>,
    private eventEmitter: EventEmitter2,
    private ragService: RagService,
  ) {}

  async create(dto: CreateProjectDto): Promise<ProjectDocument> {
    const project = await this.projectModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: project._id.toString(),
      entity: 'project',
      action: 'created',
      entityId: project._id.toString(),
      summary: `Projekt "${project.name}" erstellt`,
    });
    return project;
  }

  async findAll(
    active?: boolean,
    favorite?: boolean,
    customerId?: string,
  ): Promise<ProjectDocument[]> {
    const filter: Record<string, unknown> = {};
    if (active !== undefined) filter.active = active;
    if (favorite !== undefined) filter.favorite = favorite;

    if (customerId && Types.ObjectId.isValid(customerId)) {
      const links = await this.customerProjectLinkModel
        .find({ customerId: new Types.ObjectId(customerId) })
        .select('projectId')
        .lean()
        .exec();
      filter._id = { $in: links.map((l) => l.projectId) };
    }

    Object.assign(filter, buildScopeFilter(RequestContext.getUser(), { axis: 'project', field: '_id' }));
    return this.projectModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async findById(id: string): Promise<ProjectDocument> {
    const project = await this.projectModel.findById(id).exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessProject(actor, id)) {
      throw new ForbiddenException(`Project ${id} is not in your scope`);
    }
    return project;
  }

  async findByName(name: string): Promise<ProjectDocument | null> {
    return this.projectModel.findOne({ name }).exec();
  }

  async listTags(): Promise<Array<{ name: string; usageCount: number }>> {
    const scopeFilter = buildScopeFilter(RequestContext.getUser(), {
      axis: 'project',
      field: '_id',
    });
    const rows = await this.projectModel.aggregate<{ _id: string; usageCount: number }>([
      { $match: scopeFilter },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', usageCount: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => ({ name: r._id, usageCount: r.usageCount }));
  }

  async listCustomerLinks(): Promise<Array<{
    projectId: string;
    customerId: string;
    customerName: string;
    status: string;
    createdAt: string;
  }>> {
    const scopeFilter = buildScopeFilter(RequestContext.getUser(), {
      axis: 'project',
      field: 'projectId',
    });
    const rows = await this.customerProjectLinkModel.aggregate<{
      projectId: Types.ObjectId;
      customerId: Types.ObjectId;
      status: string;
      createdAt: Date;
      customer: { name: string };
    }>([
      { $match: scopeFilter },
      {
        $lookup: {
          from: 'customers',
          localField: 'customerId',
          foreignField: '_id',
          as: 'customer',
        },
      },
      { $unwind: '$customer' },
      { $sort: { projectId: 1, createdAt: 1 } },
    ]);
    return rows.map((r) => ({
      projectId: r.projectId.toString(),
      customerId: r.customerId.toString(),
      customerName: r.customer.name,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Set or clear the per-project replication opt-in flag. Used by the
   * replication controller's project-config endpoint. Returns the updated
   * project so the caller can forward the new state to the UI.
   */
  async setReplicationEnabled(id: string, enabled: boolean): Promise<ProjectDocument> {
    const project = await this.projectModel
      .findByIdAndUpdate(id, { replicationConfig: { enabled } }, { new: true })
      .exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: id,
      entity: 'project',
      action: 'updated',
      entityId: id,
      summary: `Replikation für "${project.name}" ${enabled ? 'aktiviert' : 'deaktiviert'}`,
    });
    return project;
  }

  /** Returns true if the project is opted in for replication. Used as a fast
   *  filter by push/receive/full-sync services — avoids `findById` overhead
   *  by only projecting the single field. */
  async isReplicationEnabled(id: string): Promise<boolean> {
    const project = await this.projectModel
      .findById(id)
      .select('replicationConfig')
      .lean<{ replicationConfig?: { enabled?: boolean } } | null>()
      .exec();
    return !!project?.replicationConfig?.enabled;
  }

  async update(id: string, dto: UpdateProjectDto): Promise<ProjectDocument> {
    const project = await this.projectModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: id,
      entity: 'project',
      action: 'updated',
      entityId: id,
      summary: `Projekt "${project.name}" aktualisiert`,
    });
    return project;
  }

  async updateRaw(id: string, update: Record<string, unknown>): Promise<ProjectDocument> {
    const project = await this.projectModel
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async searchSemantic(
    query: string,
    customerId?: string,
    limit = 20,
  ): Promise<SemanticSearchResult> {
    if (!query.trim()) {
      return { projects: [], relatedHits: [] };
    }

    let projectHits: Awaited<ReturnType<RagService['search']>>;
    let relatedHits: Awaited<ReturnType<RagService['search']>>;
    try {
      [projectHits, relatedHits] = await Promise.all([
        this.ragService.search(query, undefined, 'project', limit, customerId),
        this.ragService.search(query, undefined, undefined, limit, customerId),
      ]);
    } catch (err) {
      throw new ServiceUnavailableException({
        message: (err as Error).message || 'RAG search unavailable',
        fallback: 'substring',
      });
    }

    // Hydrate project hits with full project documents (respecting scope).
    const projectIds = projectHits.map((h) => h.id).filter((id) => Types.ObjectId.isValid(id));
    const scopeFilter = buildScopeFilter(RequestContext.getUser(), {
      axis: 'project',
      field: '_id',
    });
    const docs = await this.projectModel
      .find({ _id: { $in: projectIds }, ...scopeFilter })
      .lean()
      .exec();
    const docById = new Map(docs.map((d) => [String(d._id), d]));

    const projects = projectHits
      .map((hit) => {
        const doc = docById.get(hit.id) as
          | (Record<string, unknown> & { _id: unknown; name: string })
          | undefined;
        if (!doc) return null;
        const createdAt = doc.createdAt as Date | string | undefined;
        const updatedAt = doc.updatedAt as Date | string | undefined;
        return {
          _id: String(doc._id),
          name: doc.name,
          description: doc.description as string | undefined,
          techStack: (doc.techStack as string[] | undefined) ?? [],
          tags: (doc.tags as string[] | undefined) ?? [],
          active: doc.active as boolean,
          favorite: doc.favorite as boolean,
          score: hit.score,
          createdAt: createdAt ? new Date(createdAt).toISOString() : '',
          updatedAt: updatedAt ? new Date(updatedAt).toISOString() : '',
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // Cross-entity hits: exclude project entries (already in `projects`) and
    // entries with no projectId (we wouldn't know where to navigate).
    const projectIdSet = new Set(projects.map((p) => p._id));
    const related = relatedHits
      .filter((h) => h.entity !== 'project')
      .filter((h) => h.projectId && !projectIdSet.has(h.projectId))
      .map((h) => ({
        entity: h.entity,
        id: h.id,
        title: h.title,
        projectId: h.projectId,
        score: h.score,
      }));

    return { projects, relatedHits: related };
  }

  async remove(id: string): Promise<void> {
    const result = await this.projectModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Project ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: id,
      entity: 'project',
      action: 'deleted',
      entityId: id,
    });
  }
}
