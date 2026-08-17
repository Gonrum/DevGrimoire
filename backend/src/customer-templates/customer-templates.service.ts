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
  CustomerTemplateItemDto,
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
import { TodoPriority } from '../todos/schemas/todo.schema';
import { HealthcheckMethod } from '../monitoring/schemas/healthcheck.schema';
import { CreateEnvironmentDto } from '../environments/dto/create-environment.dto';
import { CreateWorkflowDefinitionDto } from '../workflows/dto/workflow.dto';
import { errorMessage, isRecord, isUnknownArray } from '../common/narrow';
import {
  optionalEnum,
  optionalNumber,
  optionalObject,
  optionalObjectArray,
  optionalString,
  optionalStringArray,
  ToolArgs,
} from '../common/tool-args';

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

/**
 * Element-Formen, die die Ziel-Services erwarten. Aus deren DTOs abgeleitet
 * statt hier nachgebaut: ein selbst erfundenes `{ key: string; value: string }`
 * wäre eine zweite Wahrheit, die beim nächsten Feld auseinanderläuft.
 */
type EnvVariableInput = NonNullable<CreateEnvironmentDto['variables']>[number];
type WorkflowNodeInput = NonNullable<CreateWorkflowDefinitionDto['nodes']>[number];
type WorkflowEdgeInput = NonNullable<CreateWorkflowDefinitionDto['edges']>[number];

/**
 * DTO-Item → Schema-Item.
 *
 * Der Unterschied sind genau die drei Felder mit Schema-Default (`payload`,
 * `requiredSecretKeys`, `placeholders`): im DTO optional, im Schema gesetzt.
 * Dafür stand vorher `dto.items as never` — `never` ist allem zuweisbar, die
 * Prüfung fiel damit komplett aus. Die Defaults stehen jetzt hier, statt sich
 * auf Mongoose zu verlassen.
 */
function templateItemsFromDto(items: CustomerTemplateItemDto[]): CustomerTemplateItem[] {
  return items.map((item) => ({
    kind: item.kind,
    title: item.title,
    description: item.description,
    payload: item.payload ?? {},
    requiredSecretKeys: item.requiredSecretKeys ?? [],
    placeholders: item.placeholders ?? {},
  }));
}

/**
 * Zahlen-Liste aus einem Payload-Feld (`expectedStatus`).
 *
 * Politik wie bei den `optional*`-Lesern in `common/tool-args.ts`: fehlt das
 * Feld, greift der Default; ist es da, aber falsch geformt, bricht *dieses*
 * Template-Item ab statt still zu verschwinden. Der Helfer fehlt dort bisher —
 * siehe Bericht.
 */
function optionalNumberArray(args: ToolArgs, field: string): number[] | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!isUnknownArray(value)) {
    throw new BadRequestException(`${field} must be an array of numbers`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new BadRequestException(`${field} must be an array of numbers`);
    }
    return entry;
  });
}

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
   *
   * Der Parameter nennt genau die zwei Felder, die durchsucht werden — damit
   * passen DTO-Items (payload/placeholders optional) und Schema-Items (mit
   * Default) beide hinein, ohne das `as never` an den Aufrufstellen.
   */
  private assertNoSecretValues(
    items: ReadonlyArray<{ payload?: unknown; placeholders?: unknown }> | undefined,
  ): void {
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
    if (isUnknownArray(value)) {
      value.forEach((item, idx) => this.walkForSecrets(item, `${path}[${idx}]`));
      return;
    }
    // `isRecord` statt `typeof value === 'object'` + Behauptung: das Prädikat
    // erlaubt den Feldzugriff, ohne etwas über die Feldtypen zu behaupten.
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
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
    this.assertNoSecretValues(dto.items);
    const created = await this.templateModel.create({
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      type: dto.type,
      active: dto.active ?? true,
      tags: dto.tags ?? [],
      items: dto.items ? templateItemsFromDto(dto.items) : [],
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
      this.assertNoSecretValues(dto.items);
    }

    const touchesRuntime = RUNTIME_FIELDS.some((field) => dto[field] !== undefined);
    const willBump = dto.publish === true || touchesRuntime;

    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.type !== undefined) existing.type = dto.type;
    if (dto.active !== undefined) existing.active = dto.active;
    if (dto.tags !== undefined) existing.tags = dto.tags;
    if (dto.items !== undefined) existing.items = templateItemsFromDto(dto.items);
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

  // Kein `userId`-Parameter: er war deklariert, aber nie gelesen, und kein
  // Aufrufer (Controller, mcp-tools) hat ihn je übergeben. `ApplyResult` hat
  // auch kein Feld dafür — wer „wer hat angewendet" braucht, muss das Ergebnis
  // erweitern, nicht einen toten Parameter wiederbeleben.
  async apply(templateId: string, dto: ApplyCustomerTemplateDto): Promise<ApplyResult> {
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
      } catch (err: unknown) {
        // `errorMessage` statt `(err as Error).message`: der Text landet im
        // Ergebnis, das der Nutzer sieht. Bei allem, was kein Error ist, stand
        // dort wörtlich „failed: undefined".
        const reason = errorMessage(err);
        this.logger.warn(`Template ${template.slug} item "${item.title}" failed: ${reason}`);
        created.push({
          kind: item.kind,
          title: item.title,
          note: `failed: ${reason}`,
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

  /**
   * `item.payload` ist ungeprüftes JSON aus dem Template — dieselbe Lage wie bei
   * Tool-Argumenten, deshalb dieselben Leser (`common/tool-args.ts`). Sie prüfen
   * zur Laufzeit und liefern getypte Werte; die frühere Variante behauptete mit
   * `as never` / `as string`, dass schon alles passt.
   *
   * Politik der Leser: fehlendes Feld → `undefined`, also greift der
   * Schema-Default wie bisher. Vorhandenes, aber falsch geformtes Feld → Wurf.
   * Der Wurf landet im `catch` von `apply()` und erscheint als
   * `failed: <Grund>` am Ergebnis-Item — vorher fiel so ein Feld still auf den
   * Default zurück oder lief als Lüge in Mongoose.
   */
  private async applyItem(
    item: CustomerTemplateItem,
    customerId: string,
  ): Promise<AppliedEntity> {
    const p: ToolArgs = item.payload ?? {};
    switch (item.kind) {
      case CustomerTemplateItemKind.TODO: {
        const todo = await this.todosService.create({
          customerId,
          title: item.title,
          description: item.description,
          priority: optionalEnum(p, 'priority', Object.values(TodoPriority)),
          tags: optionalStringArray(p, 'tags'),
        });
        return { kind: item.kind, id: todo._id.toString(), title: todo.title };
      }
      case CustomerTemplateItemKind.ENVIRONMENT: {
        const env = await this.environmentsService.create({
          customerId,
          name: optionalString(p, 'name') || item.title,
          description: item.description,
          host: optionalString(p, 'host') || undefined,
          port: optionalNumber(p, 'port') || undefined,
          user: optionalString(p, 'user') || undefined,
          url: optionalString(p, 'url') || optionalString(p, 'urlPlaceholder') || undefined,
          variables: optionalObjectArray<EnvVariableInput>(p, 'variables'),
          active: typeof p.active === 'boolean' ? p.active : true,
        });
        return { kind: item.kind, id: env._id.toString(), title: env.name };
      }
      case CustomerTemplateItemKind.CONTACT_TYPE: {
        const contact = await this.contactsService.create(customerId, {
          name: item.title,
          role: optionalString(p, 'role') || item.title,
          notes: item.description,
        });
        return { kind: item.kind, id: contact._id.toString(), title: contact.name };
      }
      case CustomerTemplateItemKind.MONITORING_CHECK: {
        const url = optionalString(p, 'url');
        if (!url) {
          throw new BadRequestException('monitoring_check requires payload.url');
        }
        const check = await this.monitoringService.create({
          customerId,
          name: item.title,
          description: item.description,
          url,
          method: optionalEnum(p, 'method', Object.values(HealthcheckMethod)),
          intervalSeconds: typeof p.intervalSeconds === 'number' ? p.intervalSeconds : 300,
          expectedStatus: optionalNumberArray(p, 'expectedStatus'),
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
          tags: optionalStringArray(p, 'tags'),
          trigger: optionalObject(p, 'trigger'),
          nodes: optionalObjectArray<WorkflowNodeInput>(p, 'nodes'),
          edges: optionalObjectArray<WorkflowEdgeInput>(p, 'edges'),
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
