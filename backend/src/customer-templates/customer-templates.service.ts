import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import {
  CustomerTemplate,
  CustomerTemplateDocument,
  CustomerTemplateItem,
  CustomerTemplateItemKind,
} from './schemas/customer-template.schema';
import {
  ApplyCustomerTemplateDto,
  CreateCustomerTemplateDto,
  ListCustomerTemplatesDto,
  UpdateCustomerTemplateDto,
} from './dto/customer-template.dto';
import { TodosService } from '../todos/todos.service';
import { EnvironmentsService } from '../environments/environments.service';
import { ContactsService } from '../contacts/contacts.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { CustomersService } from '../customers/customers.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { WorkflowScope } from '../workflows/schemas/workflow-definition.schema';

const SECRET_KEY_HINTS = new Set([
  'value',
  'secret',
  'secrets',
  'apikey',
  'api_key',
  'token',
  'password',
  'passwd',
  'pass',
  'authorization',
  'bearer',
]);
const SECRET_VALUE_PATTERNS = [/cv_[A-Za-z0-9_-]{12,}/, /sk-[A-Za-z0-9_-]{16,}/, /Bearer\s+\S+/i];

export interface AppliedEntity {
  kind: CustomerTemplateItemKind;
  id?: string;
  title: string;
  note?: string;
}

export interface ApplyResult {
  templateId: string;
  templateVersion: number;
  customerId: string;
  appliedAt: Date;
  created: AppliedEntity[];
  missingSecretKeys: string[];
}

const RUNTIME_FIELDS: Array<keyof UpdateCustomerTemplateDto> = ['items', 'type'];

@Injectable()
export class CustomerTemplatesService {
  private readonly logger = new Logger(CustomerTemplatesService.name);

  constructor(
    @InjectModel(CustomerTemplate.name)
    private readonly templateModel: Model<CustomerTemplateDocument>,
    private readonly todosService: TodosService,
    private readonly environmentsService: EnvironmentsService,
    private readonly contactsService: ContactsService,
    private readonly monitoringService: MonitoringService,
    private readonly workflowsService: WorkflowsService,
    private readonly customersService: CustomersService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Reject template payloads that look like they smuggled secret values in.
   * Templates only carry secret *requirements* (requiredSecretKeys), never values.
   */
  private assertNoSecretValues(items: CustomerTemplateItem[] | undefined): void {
    for (const item of items ?? []) {
      this.walkForSecrets(item.payload, `items[].payload`);
      this.walkForSecrets(item.placeholders, `items[].placeholders`);
    }
  }

  private walkForSecrets(value: unknown, path: string): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (const pattern of SECRET_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          throw new BadRequestException(`Secret-looking value detected at ${path}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, idx) => this.walkForSecrets(item, `${path}[${idx}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_HINTS.has(key.toLowerCase()) && typeof child === 'string' && child.length > 0) {
          throw new BadRequestException(
            `Template field "${key}" at ${path} looks like a secret value. Use requiredSecretKeys instead.`,
          );
        }
        this.walkForSecrets(child, `${path}.${key}`);
      }
    }
  }

  async create(dto: CreateCustomerTemplateDto, userId?: string): Promise<CustomerTemplateDocument> {
    if (!dto.slug.match(/^[a-z0-9][a-z0-9-]*$/)) {
      throw new BadRequestException('slug must be lowercase letters, digits, and hyphens only');
    }
    this.assertNoSecretValues(dto.items as never);
    const created = await this.templateModel.create({
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      type: dto.type,
      active: dto.active ?? true,
      tags: dto.tags ?? [],
      items: dto.items ?? [],
      version: 1,
      createdByUserId: userId && isValidObjectId(userId) ? new Types.ObjectId(userId) : undefined,
    });
    return created;
  }

  async list(query: ListCustomerTemplatesDto): Promise<CustomerTemplateDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.type) filter.type = query.type;
    if (typeof query.active === 'boolean') filter.active = query.active;
    if (query.tag) filter.tags = query.tag;
    return this.templateModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async findById(id: string): Promise<CustomerTemplateDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid template id');
    const t = await this.templateModel.findById(id).exec();
    if (!t) throw new NotFoundException(`CustomerTemplate ${id} not found`);
    return t;
  }

  async update(
    id: string,
    dto: UpdateCustomerTemplateDto,
    userId?: string,
  ): Promise<CustomerTemplateDocument> {
    const existing = await this.findById(id);
    if (dto.items !== undefined) {
      this.assertNoSecretValues(dto.items as never);
    }

    const touchesRuntime = RUNTIME_FIELDS.some((field) => dto[field] !== undefined);
    const willBump = dto.publish === true || touchesRuntime;

    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.type !== undefined) existing.type = dto.type;
    if (dto.active !== undefined) existing.active = dto.active;
    if (dto.tags !== undefined) existing.tags = dto.tags;
    if (dto.items !== undefined) existing.items = dto.items as never;
    if (userId && isValidObjectId(userId)) {
      existing.updatedByUserId = new Types.ObjectId(userId);
    }
    if (willBump) existing.version += 1;

    return existing.save();
  }

  async remove(id: string): Promise<void> {
    const t = await this.findById(id);
    await t.deleteOne();
  }

  /**
   * Dry-run: returns what would be generated, without persisting.
   */
  async preview(templateId: string, customerId: string): Promise<{
    template: { id: string; name: string; type: string; version: number };
    items: Array<{ kind: CustomerTemplateItemKind; title: string; description?: string; payload: Record<string, unknown> }>;
    requiredSecretKeys: string[];
  }> {
    const template = await this.findById(templateId);
    if (!template.active) throw new BadRequestException('Template is not active');
    await this.customersService.findById(customerId); // validates id + access

    const requiredSecretKeys = new Set<string>();
    const items = template.items.map((item) => {
      (item.requiredSecretKeys ?? []).forEach((k) => requiredSecretKeys.add(k));
      return {
        kind: item.kind,
        title: item.title,
        description: item.description,
        payload: item.payload ?? {},
      };
    });

    return {
      template: {
        id: template._id.toString(),
        name: template.name,
        type: template.type,
        version: template.version,
      },
      items,
      requiredSecretKeys: [...requiredSecretKeys],
    };
  }

  async apply(
    templateId: string,
    dto: ApplyCustomerTemplateDto,
    userId?: string,
  ): Promise<ApplyResult> {
    const template = await this.findById(templateId);
    if (!template.active) throw new BadRequestException('Template is not active');
    await this.customersService.findById(dto.customerId);

    const created: AppliedEntity[] = [];
    const requiredSecretKeys = new Set<string>();

    for (const item of template.items) {
      (item.requiredSecretKeys ?? []).forEach((k) => requiredSecretKeys.add(k));
      try {
        const applied = await this.applyItem(item, dto.customerId);
        created.push(applied);
      } catch (err) {
        this.logger.warn(
          `Template ${template.slug} item "${item.title}" failed: ${(err as Error).message}`,
        );
        created.push({
          kind: item.kind,
          title: item.title,
          note: `failed: ${(err as Error).message}`,
        });
      }
    }

    const result: ApplyResult = {
      templateId: template._id.toString(),
      templateVersion: template.version,
      customerId: dto.customerId,
      appliedAt: new Date(),
      created,
      missingSecretKeys: [...requiredSecretKeys],
    };

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: null,
      customerId: dto.customerId,
      entity: 'customer-template-apply',
      action: 'created',
      entityId: template._id.toString(),
      summary: `Template "${template.name}" v${template.version} angewendet — ${created.length} Einträge`,
    });

    return result;
  }

  private async applyItem(
    item: CustomerTemplateItem,
    customerId: string,
  ): Promise<AppliedEntity> {
    const p = item.payload ?? {};
    switch (item.kind) {
      case CustomerTemplateItemKind.TODO: {
        const todo = await this.todosService.create({
          customerId,
          title: item.title,
          description: item.description,
          priority: (p.priority as never) || undefined,
          tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
        });
        return { kind: item.kind, id: todo._id.toString(), title: todo.title };
      }
      case CustomerTemplateItemKind.ENVIRONMENT: {
        const env = await this.environmentsService.create({
          customerId,
          name: (p.name as string) || item.title,
          description: item.description,
          host: (p.host as string) || undefined,
          port: (p.port as number) || undefined,
          user: (p.user as string) || undefined,
          url: (p.url as string) || (p.urlPlaceholder as string) || undefined,
          variables: Array.isArray(p.variables) ? (p.variables as never) : undefined,
          active: typeof p.active === 'boolean' ? p.active : true,
        });
        return { kind: item.kind, id: env._id.toString(), title: env.name };
      }
      case CustomerTemplateItemKind.CONTACT_TYPE: {
        const contact = await this.contactsService.create(customerId, {
          name: item.title,
          role: (p.role as string) || item.title,
          notes: item.description,
        });
        return { kind: item.kind, id: contact._id.toString(), title: contact.name };
      }
      case CustomerTemplateItemKind.MONITORING_CHECK: {
        if (!p.url || typeof p.url !== 'string') {
          throw new BadRequestException('monitoring_check requires payload.url');
        }
        const check = await this.monitoringService.create({
          customerId,
          name: item.title,
          description: item.description,
          url: p.url,
          method: (p.method as never) || undefined,
          intervalSeconds: typeof p.intervalSeconds === 'number' ? p.intervalSeconds : 300,
          expectedStatus: Array.isArray(p.expectedStatus) ? (p.expectedStatus as number[]) : undefined,
          failureThreshold: typeof p.failureThreshold === 'number' ? p.failureThreshold : 3,
          active: typeof p.active === 'boolean' ? p.active : true,
        });
        return { kind: item.kind, id: check._id.toString(), title: check.name };
      }
      case CustomerTemplateItemKind.WORKFLOW: {
        const def = await this.workflowsService.createDefinition({
          scope: WorkflowScope.CUSTOMER,
          customerId,
          name: item.title,
          description: item.description,
          tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
          trigger: (p.trigger as Record<string, unknown>) || undefined,
          nodes: Array.isArray(p.nodes) ? (p.nodes as never) : undefined,
          edges: Array.isArray(p.edges) ? (p.edges as never) : undefined,
        });
        return { kind: item.kind, id: def._id.toString(), title: def.name };
      }
      case CustomerTemplateItemKind.NOTE:
      default:
        return {
          kind: CustomerTemplateItemKind.NOTE,
          title: item.title,
          note: item.description ?? '(no description)',
        };
    }
  }
}
