import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isDuplicateKeyError } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { ProjectsService } from '../projects/projects.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { Todo, TodoDocument, TodoStatus } from '../todos/schemas/todo.schema';
import { Environment, EnvironmentDocument } from '../environments/schemas/environment.schema';
import { Customer, CustomerDocument, CustomerStatus } from './schemas/customer.schema';
import {
  CustomerProjectLink,
  CustomerProjectLinkDocument,
} from './schemas/customer-project-link.schema';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import {
  CreateCustomerProjectLinkDto,
  UpdateCustomerProjectLinkDto,
} from './dto/customer-project-link.dto';
import { RequestContext } from '../common/request-context';
import { actorCanAccessCustomer, actorMay, Permission, PermissionId } from '../common/permissions';
import { buildScopeFilter } from '../common/scope';
import { assertOwnerInScope, projectScopeFilter } from '../common/scope-guard';

export interface CustomerListFilters {
  status?: CustomerStatus;
  tag?: string;
  q?: string;
  includeArchived?: boolean;
  projectId?: string;
}

export interface CustomerDashboardEntry {
  customerId: string;
  name: string;
  status: CustomerStatus;
  openTodoCount: number;
  projectCount: number;
  /**
   * Optional, weil `timestamps: true` das Feld nicht am Typ garantiert (z.B.
   * bei einer `.select()`-Projektion). Vorher stand hier `Date` und der
   * Zugriff lief über `as unknown as { updatedAt: Date }` — die Behauptung
   * hat nur verdeckt, dass zur Laufzeit ohnehin `undefined` herauskam.
   * Das Frontend rendert das Feld derzeit nicht.
   */
  lastActivityAt?: Date;
}

export interface CustomerDashboard {
  summary: {
    totalActive: number;
    withOpenTodos: number;
    withoutProjects: number;
    recentlyUpdated: number;
  };
  customers: CustomerDashboardEntry[];
}

@Injectable()
export class CustomersService {
  constructor(
    @InjectModel(Customer.name) private customerModel: Model<CustomerDocument>,
    @InjectModel(CustomerProjectLink.name)
    private customerProjectLinkModel: Model<CustomerProjectLinkDocument>,
    @InjectModel(Todo.name) private todoModel: Model<TodoDocument>,
    private readonly projectsService: ProjectsService,
    private eventEmitter: EventEmitter2,
    // Model instead of EnvironmentsService: EnvironmentsModule imports
    // CustomersModule, the service would close a module cycle.
    @InjectModel(Environment.name) private environmentModel?: Model<EnvironmentDocument>,
  ) {}

  /**
   * Validates the environments a customer-project link references. The UI
   * offers the linked project's environments; the customer's own ones are
   * part of the same relation and accepted too. Anything else (a foreign
   * project's environment) is rejected: consumers resolve these ids later,
   * possibly without an actor, and would expose a foreign environment's
   * plaintext variables through the link. Missing and foreign ids get the
   * same 400 so the check is no existence oracle.
   */
  private async resolveLinkEnvironmentIds(
    ids: string[],
    projectId: Types.ObjectId,
    customerId: Types.ObjectId,
    previouslyStored: ReadonlySet<string> = new Set(),
  ): Promise<Types.ObjectId[]> {
    const objectIds = ids.map((id) => this.objectId(id, 'environmentId'));
    if (objectIds.length === 0) return [];
    if (!this.environmentModel) {
      throw new BadRequestException('Environment references cannot be validated');
    }
    const unique = [...new Map(objectIds.map((id) => [id.toString(), id])).values()];
    const found = await this.environmentModel
      .find({
        _id: { $in: unique },
        $or: [{ projectId }, { customerId }],
      })
      .select('_id')
      .lean()
      .exec();
    const ok = new Set(found.map((env) => env._id.toString()));
    let bad = unique.filter((id) => !ok.has(id.toString()));
    // The edit form sends back the stored list; an environment deleted since
    // then must not make the link unsavable. Such ids are dropped — but only
    // when they no longer exist at all, a stored foreign id still fails.
    const stale = bad.filter((id) => previouslyStored.has(id.toString()));
    if (stale.length > 0) {
      const stillThere = await this.environmentModel
        .find({ _id: { $in: stale } })
        .select('_id')
        .lean()
        .exec();
      const existing = new Set(stillThere.map((env) => env._id.toString()));
      const dropped = new Set(stale.filter((id) => !existing.has(id.toString())).map((id) => id.toString()));
      bad = bad.filter((id) => !dropped.has(id.toString()));
      if (bad.length === 0) return unique.filter((id) => !dropped.has(id.toString()));
    }
    if (bad.length > 0) {
      throw new BadRequestException(
        `Environment ${bad[0].toString()} does not belong to the linked project or customer`,
      );
    }
    return unique;
  }

  private objectId(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  async create(dto: CreateCustomerDto): Promise<CustomerDocument> {
    const actor = RequestContext.getUser();
    if (actor && !actorMay(actor, Permission.CUSTOMER_WRITE)) {
      throw new ForbiddenException(`Missing permission ${Permission.CUSTOMER_WRITE}`);
    }
    try {
      const customer = await this.customerModel.create(dto);
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: null,
        customerId: customer._id.toString(),
        entity: 'customer',
        action: 'created',
        entityId: customer._id.toString(),
        summary: `Kunde "${customer.name}" angelegt`,
      });
      return customer;
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Customer "${dto.name}" already exists`);
      }
      throw err;
    }
  }

  async findAll(filters: CustomerListFilters = {}): Promise<CustomerDocument[]> {
    // Without any customer permission the actor may not even see the list.
    const listActor = RequestContext.getUser();
    if (listActor && !actorMay(listActor, Permission.CUSTOMER_READ)) return [];
    const query: Record<string, unknown> = {};
    if (filters.status) {
      query.status = filters.status;
    } else if (!filters.includeArchived) {
      query.status = { $ne: CustomerStatus.ARCHIVED };
    }
    if (filters.tag) query.tags = filters.tag;
    if (filters.q) query.$text = { $search: filters.q };

    if (filters.projectId) {
      const projectId = this.objectId(filters.projectId, 'projectId');
      await this.projectsService.findById(filters.projectId);
      const links = await this.customerProjectLinkModel
        .find({ projectId })
        .select('customerId')
        .lean()
        .exec();
      query._id = { $in: links.map((link) => link.customerId) };
    }

    Object.assign(query, buildScopeFilter(RequestContext.getUser(), { axis: 'customer', field: '_id' }));

    return this.customerModel.find(query).sort({ updatedAt: -1 }).exec();
  }

  async getDashboard(): Promise<CustomerDashboard> {
    // Active set: everything that's not archived. Operations dashboard cares
    // about lifecycle states up to and including offboarding/cancelled.
    const customers = await this.customerModel
      .find(
        {
          ...{ status: { $ne: CustomerStatus.ARCHIVED } },
          ...buildScopeFilter(RequestContext.getUser(), { axis: 'customer', field: '_id' }),
        },
      )
      .sort({ updatedAt: -1 })
      .exec();

    if (customers.length === 0) {
      return {
        summary: { totalActive: 0, withOpenTodos: 0, withoutProjects: 0, recentlyUpdated: 0 },
        customers: [],
      };
    }

    const ids = customers.map((c) => c._id);
    const openStatuses = [TodoStatus.OPEN, TodoStatus.IN_PROGRESS, TodoStatus.REVIEW];

    // Two aggregations beat N+1 counts: one for todos, one for project links.
    const [todoCounts, linkCounts] = await Promise.all([
      this.todoModel.aggregate([
        { $match: { customerId: { $in: ids }, status: { $in: openStatuses }, archived: { $ne: true } } },
        { $group: { _id: '$customerId', count: { $sum: 1 } } },
      ]),
      this.customerProjectLinkModel.aggregate([
        { $match: { customerId: { $in: ids } } },
        { $group: { _id: '$customerId', count: { $sum: 1 } } },
      ]),
    ]);

    const todoMap = new Map<string, number>(
      todoCounts.map((row: { _id: Types.ObjectId; count: number }) => [row._id.toString(), row.count]),
    );
    const linkMap = new Map<string, number>(
      linkCounts.map((row: { _id: Types.ObjectId; count: number }) => [row._id.toString(), row.count]),
    );

    const entries: CustomerDashboardEntry[] = customers.map((c) => ({
      customerId: c._id.toString(),
      name: c.name,
      status: c.status,
      openTodoCount: todoMap.get(c._id.toString()) ?? 0,
      projectCount: linkMap.get(c._id.toString()) ?? 0,
      lastActivityAt: c.updatedAt,
    }));

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return {
      summary: {
        totalActive: entries.length,
        withOpenTodos: entries.filter((e) => e.openTodoCount > 0).length,
        withoutProjects: entries.filter((e) => e.projectCount === 0).length,
        recentlyUpdated: entries.filter((e) => e.lastActivityAt && e.lastActivityAt >= thirtyDaysAgo).length,
      },
      customers: entries,
    };
  }

  /**
   * Kunden-Scope-Prüfung (T-220). Stand vorher ausschließlich in findById();
   * update() und archive() gingen direkt auf findByIdAndUpdate — ein auf
   * `customerScopeMode: 'allowlist'` verengter Actor konnte damit einen fremden
   * Kunden überschreiben und archivieren (und ihn damit allen entziehen).
   *
   * Läuft auf der Id und VOR dem Load, damit eine fremde Id 403 statt 404
   * ergibt. `if (actor)` ist die dokumentierte Konvention dieses Projekts: ein
   * fehlender Actor ist ein vertrauenswürdiger interner Aufrufer.
   */
  private assertAccess(id: string, perm: PermissionId = Permission.CUSTOMER_READ): void {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessCustomer(actor, id)) {
      throw new ForbiddenException(`Customer ${id} is not in your scope`);
    }
    if (actor && !actorMay(actor, perm)) {
      throw new ForbiddenException(`Missing permission ${perm}`);
    }
  }

  async findById(id: string): Promise<CustomerDocument> {
    const customer = await this.customerModel.findById(this.objectId(id, 'customerId')).exec();
    if (!customer) throw new NotFoundException(`Customer ${id} not found`);
    this.assertAccess(id);
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<CustomerDocument> {
    this.assertAccess(id, Permission.CUSTOMER_WRITE);
    try {
      const customer = await this.customerModel
        .findByIdAndUpdate(this.objectId(id, 'customerId'), dto, { new: true })
        .exec();
      if (!customer) throw new NotFoundException(`Customer ${id} not found`);
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: null,
        customerId: customer._id.toString(),
        entity: 'customer',
        action: 'updated',
        entityId: customer._id.toString(),
        summary: `Kunde "${customer.name}" aktualisiert`,
      });
      return customer;
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Customer "${dto.name}" already exists`);
      }
      throw err;
    }
  }

  async archive(id: string): Promise<CustomerDocument> {
    this.assertAccess(id, Permission.CUSTOMER_ARCHIVE);
    const customer = await this.customerModel
      .findByIdAndUpdate(
        this.objectId(id, 'customerId'),
        { status: CustomerStatus.ARCHIVED },
        { new: true },
      )
      .exec();
    if (!customer) throw new NotFoundException(`Customer ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: null,
      customerId: customer._id.toString(),
      entity: 'customer',
      action: 'updated',
      entityId: customer._id.toString(),
      summary: `Kunde "${customer.name}" archiviert`,
    });
    return customer;
  }

  async createProjectLink(
    customerId: string,
    dto: CreateCustomerProjectLinkDto,
  ): Promise<CustomerProjectLinkDocument> {
    const customer = await this.findById(customerId);
    const project = await this.projectsService.findById(dto.projectId);
    const customerObjectId = this.objectId(customerId, 'customerId');
    const projectObjectId = this.objectId(dto.projectId, 'projectId');
    const environmentIds = await this.resolveLinkEnvironmentIds(
      dto.environmentIds ?? [],
      projectObjectId,
      customerObjectId,
    );
    try {
      const link = await this.customerProjectLinkModel.create({
        ...dto,
        customerId: customerObjectId,
        projectId: projectObjectId,
        environmentIds,
      });
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: project._id.toString(),
        entity: 'customer-project',
        action: 'created',
        entityId: link._id.toString(),
        summary: `Projekt "${project.name}" mit Kunde "${customer.name}" verknüpft`,
      });
      return link;
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException('Project is already linked to this customer');
      }
      throw err;
    }
  }

  async findProjectLinks(customerId: string): Promise<CustomerProjectLinkDocument[]> {
    await this.findById(customerId);
    // A link is a relation entity: the customer check alone would list links
    // (and their project ids/notes) of projects outside the actor's scope.
    return this.customerProjectLinkModel
      .find({ customerId: this.objectId(customerId, 'customerId'), ...projectScopeFilter() })
      .sort({ updatedAt: -1 })
      .exec();
  }

  async findLinksByProject(projectId: string): Promise<CustomerProjectLinkDocument[]> {
    await this.projectsService.findById(projectId);
    // Same as above, other axis: hide links to customers outside the scope.
    return this.customerProjectLinkModel
      .find({
        projectId: this.objectId(projectId, 'projectId'),
        ...buildScopeFilter(RequestContext.getUser(), { axis: 'customer', field: 'customerId' }),
      })
      .sort({ updatedAt: -1 })
      .exec();
  }

  /**
   * Loads a link of this customer and requires BOTH axes — mutating a link
   * also changes what the linked project sees, so customer scope alone is
   * not enough. Runs before any write.
   */
  private async findScopedLink(customerId: string, linkId: string): Promise<CustomerProjectLinkDocument> {
    const link = await this.customerProjectLinkModel
      .findOne({
        _id: this.objectId(linkId, 'linkId'),
        customerId: this.objectId(customerId, 'customerId'),
      })
      .exec();
    if (!link) throw new NotFoundException(`Customer project link ${linkId} not found`);
    assertOwnerInScope(
      { projectId: link.projectId, customerId: link.customerId },
      `Customer project link ${linkId}`,
    );
    return link;
  }

  async updateProjectLink(
    customerId: string,
    linkId: string,
    dto: UpdateCustomerProjectLinkDto,
  ): Promise<CustomerProjectLinkDocument> {
    const customer = await this.findById(customerId);
    const existing = await this.findScopedLink(customerId, linkId);
    const update: Record<string, unknown> = { ...dto };
    if (dto.environmentIds) {
      update.environmentIds = await this.resolveLinkEnvironmentIds(
        dto.environmentIds,
        existing.projectId,
        existing.customerId,
        new Set((existing.environmentIds ?? []).map((id) => id.toString())),
      );
    }
    const link = await this.customerProjectLinkModel
      .findOneAndUpdate(
        {
          _id: this.objectId(linkId, 'linkId'),
          customerId: this.objectId(customerId, 'customerId'),
        },
        update,
        { new: true },
      )
      .exec();
    if (!link) throw new NotFoundException(`Customer project link ${linkId} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: link.projectId.toString(),
      entity: 'customer-project',
      action: 'updated',
      entityId: link._id.toString(),
      summary: `Kundenverknüpfung für "${customer.name}" aktualisiert`,
    });
    return link;
  }

  async deleteProjectLink(customerId: string, linkId: string): Promise<void> {
    const customer = await this.findById(customerId);
    await this.findScopedLink(customerId, linkId);
    const result = await this.customerProjectLinkModel
      .findOneAndDelete({
        _id: this.objectId(linkId, 'linkId'),
        customerId: this.objectId(customerId, 'customerId'),
      })
      .exec();
    if (!result) throw new NotFoundException(`Customer project link ${linkId} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'customer-project',
      action: 'deleted',
      entityId: result._id.toString(),
      summary: `Kundenverknüpfung für "${customer.name}" entfernt`,
    });
  }
}
