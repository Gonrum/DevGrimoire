import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { ProjectsService } from '../projects/projects.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { Todo, TodoDocument, TodoStatus } from '../todos/schemas/todo.schema';
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
import { actorCanAccessCustomer } from '../common/permissions';
import { buildScopeFilter } from '../common/scope';

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
  lastActivityAt: Date;
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
  ) {}

  private objectId(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  async create(dto: CreateCustomerDto): Promise<CustomerDocument> {
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
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(`Customer "${dto.name}" already exists`);
      }
      throw err;
    }
  }

  async findAll(filters: CustomerListFilters = {}): Promise<CustomerDocument[]> {
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
      lastActivityAt: (c as unknown as { updatedAt: Date }).updatedAt,
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

  async findById(id: string): Promise<CustomerDocument> {
    const customer = await this.customerModel.findById(this.objectId(id, 'customerId')).exec();
    if (!customer) throw new NotFoundException(`Customer ${id} not found`);
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessCustomer(actor, id)) {
      throw new ForbiddenException(`Customer ${id} is not in your scope`);
    }
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<CustomerDocument> {
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
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(`Customer "${dto.name}" already exists`);
      }
      throw err;
    }
  }

  async archive(id: string): Promise<CustomerDocument> {
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
    try {
      const link = await this.customerProjectLinkModel.create({
        ...dto,
        customerId: customerObjectId,
        projectId: projectObjectId,
        environmentIds: dto.environmentIds?.map((id) => this.objectId(id, 'environmentId')) ?? [],
      });
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: project._id.toString(),
        entity: 'customer-project',
        action: 'created',
        entityId: link._id.toString(),
        summary: `Projekt "${project.name}" mit Kunde "${customer.name}" verknüpft`,
      });
      return link;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException('Project is already linked to this customer');
      }
      throw err;
    }
  }

  async findProjectLinks(customerId: string): Promise<CustomerProjectLinkDocument[]> {
    await this.findById(customerId);
    return this.customerProjectLinkModel
      .find({ customerId: this.objectId(customerId, 'customerId') })
      .sort({ updatedAt: -1 })
      .exec();
  }

  async findLinksByProject(projectId: string): Promise<CustomerProjectLinkDocument[]> {
    await this.projectsService.findById(projectId);
    return this.customerProjectLinkModel
      .find({ projectId: this.objectId(projectId, 'projectId') })
      .sort({ updatedAt: -1 })
      .exec();
  }

  async updateProjectLink(
    customerId: string,
    linkId: string,
    dto: UpdateCustomerProjectLinkDto,
  ): Promise<CustomerProjectLinkDocument> {
    const customer = await this.findById(customerId);
    const update: Record<string, unknown> = { ...dto };
    if (dto.environmentIds) {
      update.environmentIds = dto.environmentIds.map((id) => this.objectId(id, 'environmentId'));
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
