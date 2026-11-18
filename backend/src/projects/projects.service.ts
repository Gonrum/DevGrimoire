import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { errorMessage } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
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
import { Secret, SecretDocument } from '../secrets/schemas/secret.schema';
import { secretBelongsTo } from '../secrets/secret-owner';
import { assertAdmin, assertCustomerInScope, scopeFilter } from '../common/scope-guard';

/** The git-repository fields this service validates on write. */
interface GitRepositoryRefs {
  baseUrl?: string;
  tokenSecretId?: string;
  allowPrivateHost?: boolean;
}

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
    private moduleRef: ModuleRef,
    // Last on purpose: check scripts construct this service positionally.
    @InjectModel(Secret.name) private secretModel: Model<SecretDocument>,
  ) {}

  private getRagService(): RagService {
    // Lazy lookup über den globalen DI-Container — ProjectsModule kann
    // RagModule nicht direkt importieren (Circular-Module-Init), aber
    // RagService ist als globaler Provider verfügbar.
    return this.moduleRef.get(RagService, { strict: false });
  }

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

    // Without this, `?customerId=<foreign>` reveals which in-scope projects are
    // linked to a customer outside the actor's scope.
    if (customerId) assertCustomerInScope(customerId);
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

  /**
   * Projekt-Scope-Prüfung (T-210). Stand vorher ausschließlich in findById();
   * update(), updateRaw() und remove() gingen direkt auf findByIdAndUpdate bzw.
   * findByIdAndDelete — ein auf `projectScopeMode: 'allowlist'` verengter Actor
   * konnte damit ein FREMDES Projekt überschreiben (Name, gitRepositories inkl.
   * Token-Secret-Ids, replicationConfig) und löschen, wobei der
   * PROJECT_CHANGED-Event die Kaskade über 21 Services auslöst.
   *
   * Die Prüfung läuft auf der Id, nicht auf dem geladenen Dokument: das Projekt
   * IST der Scope-Träger. Sie steht bewusst VOR dem Load, damit eine fremde Id
   * 403 statt 404 ergibt und nicht einmal verrät, ob es das Projekt gibt.
   *
   * `if (actor)` ist die dokumentierte Konvention dieses Projekts: ein
   * fehlender Actor ist ein vertrauenswürdiger interner Aufrufer (Replikation,
   * Migration, stdio-MCP ohne HTTP-Kontext).
   */
  private assertAccess(id: string): void {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessProject(actor, id)) {
      throw new ForbiddenException(`Project ${id} is not in your scope`);
    }
  }

  async findById(id: string): Promise<ProjectDocument> {
    const project = await this.projectModel.findById(id).exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    this.assertAccess(id);
    return project;
  }

  async findByName(name: string): Promise<ProjectDocument | null> {
    const project = await this.projectModel.findOne({ name }).exec();
    // MCP `project_get {name}` went through here without any scope check.
    if (project) this.assertAccess(project._id.toString());
    return project;
  }

  /**
   * Name collision check for imports. `Project.name` is unique instance-wide,
   * so this must see foreign projects too — it returns only a boolean, never
   * the foreign document.
   */
  async nameExists(name: string): Promise<boolean> {
    return (await this.projectModel.exists({ name }).exec()) !== null;
  }

  /** Whether the project is linked to the customer (CustomerProjectLink). */
  async isLinkedToCustomer(projectId: string, customerId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(projectId) || !Types.ObjectId.isValid(customerId)) return false;
    const link = await this.customerProjectLinkModel
      .exists({ projectId: new Types.ObjectId(projectId), customerId: new Types.ObjectId(customerId) })
      .exec();
    return link !== null;
  }

  /**
   * Write-time validation of `gitRepositories` (the commit cron resolves the
   * token WITHOUT an actor and sends it to `baseUrl`):
   * - `tokenSecretId` must reference a secret of exactly this project —
   *   otherwise any secret of the instance could be exfiltrated.
   * - `allowPrivateHost` lifts the private-address block for the git host; only
   *   admins may grant it. A non-admin may keep a grant an admin already made
   *   for the same baseUrl, but not move it to a new host.
   */
  async assertGitRepositoriesAllowed(projectId: string, repos: GitRepositoryRefs[] | undefined): Promise<void> {
    if (!repos || repos.length === 0) return;
    const current = Types.ObjectId.isValid(projectId)
      ? await this.projectModel.findById(projectId).select('gitRepositories').lean().exec()
      : null;
    const currentRepos = current?.gitRepositories ?? [];

    const ids = [...new Set(repos.map((r) => r.tokenSecretId).filter((v): v is string => !!v))];
    for (const sid of ids) {
      if (!Types.ObjectId.isValid(sid)) throw new BadRequestException(`Invalid tokenSecretId ${sid}`);
    }
    if (ids.length > 0) {
      const secrets = await this.secretModel
        .find({ _id: { $in: ids.map((sid) => new Types.ObjectId(sid)) } })
        .select('projectId customerId')
        .lean()
        .exec();
      const byId = new Map(secrets.map((sec) => [sec._id.toString(), sec]));
      const stored = new Set(currentRepos.map((r) => r.tokenSecretId).filter(Boolean));
      for (const sid of ids) {
        const sec = byId.get(sid);
        if (!sec) {
          // A dangling reference that is already stored (secret deleted later)
          // is harmless — it resolves to nothing. Rejecting it would block every
          // save that echoes the repository list back.
          if (stored.has(sid)) continue;
          throw new BadRequestException(`Secret ${sid} not found`);
        }
        if (!secretBelongsTo(sec, { projectId })) {
          throw new ForbiddenException(`Secret ${sid} does not belong to this project`);
        }
      }
    }

    if (repos.some((r) => r.allowPrivateHost)) {
      const actor = RequestContext.getUser();
      if (actor && actor.role !== 'admin') {
        const approved = new Set(
          currentRepos.filter((r) => r.allowPrivateHost).map((r) => r.baseUrl ?? ''),
        );
        for (const r of repos) {
          if (r.allowPrivateHost && !approved.has(r.baseUrl ?? '')) {
            assertAdmin('allowPrivateHost on a git repository');
          }
        }
      }
    }
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

  async renameTag(from: string, to: string): Promise<{ modified: number }> {
    if (!from.trim() || !to.trim()) {
      throw new ForbiddenException('Both from and to tag names are required');
    }
    if (from === to) return { modified: 0 };

    const scopeFilter = buildScopeFilter(RequestContext.getUser(), {
      axis: 'project',
      field: '_id',
    });
    const docs = await this.projectModel
      .find({ tags: from, ...scopeFilter })
      .select('_id name tags')
      .exec();

    let modified = 0;
    for (const doc of docs) {
      const tags = doc.tags ?? [];
      const idx = tags.indexOf(from);
      if (idx === -1) continue;
      const next = [...tags];
      const targetIdx = next.indexOf(to);
      if (targetIdx === -1) {
        next[idx] = to;
      } else {
        // Target tag already on the project → merge: remove source, keep target at its position.
        next.splice(idx, 1);
      }
      doc.tags = next;
      await doc.save();
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: doc._id.toString(),
        entity: 'project',
        action: 'updated',
        entityId: doc._id.toString(),
        summary: `Tag "${from}" → "${to}" auf Projekt "${doc.name}"`,
      });
      modified++;
    }
    return { modified };
  }

  async mergeTags(sources: string[], target: string): Promise<{ modified: number }> {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new ForbiddenException('sources must be a non-empty array');
    }
    if (!target.trim()) {
      throw new ForbiddenException('target is required');
    }
    const filteredSources = sources.filter((s) => s && s !== target);
    if (filteredSources.length === 0) return { modified: 0 };

    const scopeFilter = buildScopeFilter(RequestContext.getUser(), {
      axis: 'project',
      field: '_id',
    });
    const docs = await this.projectModel
      .find({ tags: { $in: filteredSources }, ...scopeFilter })
      .select('_id name tags')
      .exec();

    let modified = 0;
    for (const doc of docs) {
      const tags = doc.tags ?? [];
      // First-source position determines target placement (when target not already present).
      let firstSourceIdx = -1;
      const next: string[] = [];
      tags.forEach((tag, i) => {
        if (filteredSources.includes(tag)) {
          if (firstSourceIdx === -1) firstSourceIdx = i;
          return; // skip — will be replaced
        }
        next.push(tag);
      });
      const existingTargetIdx = next.indexOf(target);
      if (existingTargetIdx === -1) {
        next.splice(Math.min(firstSourceIdx, next.length), 0, target);
      }
      doc.tags = next;
      await doc.save();
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: doc._id.toString(),
        entity: 'project',
        action: 'updated',
        entityId: doc._id.toString(),
        summary: `Tags ${filteredSources.join(',')} → "${target}" auf Projekt "${doc.name}"`,
      });
      modified++;
    }
    return { modified };
  }

  async deleteTag(name: string): Promise<{ modified: number }> {
    if (!name.trim()) {
      throw new ForbiddenException('Tag name is required');
    }
    const scopeFilter = buildScopeFilter(RequestContext.getUser(), {
      axis: 'project',
      field: '_id',
    });
    const docs = await this.projectModel
      .find({ tags: name, ...scopeFilter })
      .select('_id name tags')
      .exec();

    let modified = 0;
    for (const doc of docs) {
      const tags = doc.tags ?? [];
      const next = tags.filter((t) => t !== name);
      if (next.length === tags.length) continue;
      doc.tags = next;
      await doc.save();
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: doc._id.toString(),
        entity: 'project',
        action: 'updated',
        entityId: doc._id.toString(),
        summary: `Tag "${name}" entfernt von "${doc.name}"`,
      });
      modified++;
    }
    return { modified };
  }

  async listCustomerLinks(): Promise<Array<{
    projectId: string;
    customerId: string;
    customerName: string;
    status: string;
    createdAt: string;
  }>> {
    // Both axes: a link names a customer, and a customer outside the actor's
    // customer scope must not show up (not even its name).
    const linkScope = scopeFilter({ projectField: 'projectId', customerField: 'customerId' });
    const rows = await this.customerProjectLinkModel.aggregate<{
      projectId: Types.ObjectId;
      customerId: Types.ObjectId;
      status: string;
      createdAt: Date;
      customer: { name: string };
    }>([
      { $match: linkScope },
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
    this.assertAccess(id);
    await this.assertGitRepositoriesAllowed(id, dto.gitRepositories);
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
    // Derselbe Grund wie bei update(): ein roher Update-Record ist der
    // mächtigste Schreibpfad auf ein Projekt und war ungeprüft.
    this.assertAccess(id);
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
    if (customerId) assertCustomerInScope(customerId);

    const ragService = this.getRagService();
    let projectHits: Awaited<ReturnType<RagService['search']>>;
    let relatedHits: Awaited<ReturnType<RagService['search']>>;
    try {
      [projectHits, relatedHits] = await Promise.all([
        ragService.search(query, undefined, 'project', limit, customerId),
        ragService.search(query, undefined, undefined, limit, customerId),
      ]);
    } catch (err) {
      throw new ServiceUnavailableException({
        message: errorMessage(err) || 'RAG search unavailable',
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
        // `.lean()` liefert bereits den Schematyp; die sieben Behauptungen
        // hier haben ihn nur nachgebaut — und dabei `active`/`favorite` als
        // nicht-optional ausgegeben, obwohl beide am Schema optional sind.
        const doc = docById.get(hit.id);
        if (!doc) return null;
        const createdAt = doc.createdAt;
        const updatedAt = doc.updatedAt;
        return {
          _id: String(doc._id),
          name: doc.name,
          description: doc.description,
          techStack: doc.techStack ?? [],
          tags: doc.tags ?? [],
          active: doc.active ?? false,
          favorite: doc.favorite ?? false,
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
    // VOR findByIdAndDelete: die Methode löschte sonst erst und lieferte dann
    // das gelöschte Dokument. Der PROJECT_CHANGED-Event danach löst die
    // removeByProject-Kaskade über 21 Services aus — unwiederbringlich.
    this.assertAccess(id);
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
