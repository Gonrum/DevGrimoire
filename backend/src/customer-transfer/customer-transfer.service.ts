import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CustomersService } from '../customers/customers.service';
import { ContactsService } from '../contacts/contacts.service';
import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';
import { Contact, ContactDocument } from '../contacts/schemas/contact.schema';
import { Knowledge, KnowledgeDocument } from '../knowledge/schemas/knowledge.schema';
import { Todo, TodoDocument } from '../todos/schemas/todo.schema';
import { Environment, EnvironmentDocument } from '../environments/schemas/environment.schema';
import { Secret, SecretDocument } from '../secrets/schemas/secret.schema';
import { Research, ResearchDocument } from '../research/schemas/research.schema';
import { RecurringTask, RecurringTaskDocument } from '../recurring-tasks/schemas/recurring-task.schema';
import { CustomerExport, CustomerImportResult } from './customer-export.interface';

const STRIP_BASE = ['__v'];
const STRIP_OWNER = ['customerId', 'projectId'];

@Injectable()
export class CustomerTransferService {
  private readonly logger = new Logger(CustomerTransferService.name);

  constructor(
    private readonly customersService: CustomersService,
    private readonly contactsService: ContactsService,
    @InjectModel(Customer.name) private customerModel: Model<CustomerDocument>,
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Knowledge.name) private knowledgeModel: Model<KnowledgeDocument>,
    @InjectModel(Todo.name) private todoModel: Model<TodoDocument>,
    @InjectModel(Environment.name) private environmentModel: Model<EnvironmentDocument>,
    @InjectModel(Secret.name) private secretModel: Model<SecretDocument>,
    @InjectModel(Research.name) private researchModel: Model<ResearchDocument>,
    @InjectModel(RecurringTask.name) private recurringTaskModel: Model<RecurringTaskDocument>,
  ) {}

  async exportCustomer(customerId: string, includeSecretValues = false): Promise<CustomerExport> {
    if (!Types.ObjectId.isValid(customerId)) {
      throw new BadRequestException('Invalid customerId');
    }
    const customer = await this.customersService.findById(customerId);
    const cid = new Types.ObjectId(customerId);

    const [contacts, knowledge, todos, environments, secrets, research, recurringTasks] =
      await Promise.all([
        this.contactModel.find({ customerId: cid }).lean().exec(),
        this.knowledgeModel.find({ customerId: cid }).lean().exec(),
        this.todoModel.find({ customerId: cid }).lean().exec(),
        this.environmentModel.find({ customerId: cid }).lean().exec(),
        this.secretModel.find({ customerId: cid }).lean().exec(),
        this.researchModel.find({ customerId: cid }).lean().exec(),
        this.recurringTaskModel.find({ customerId: cid }).lean().exec(),
      ]);

    const customerObj = this.stripFields(this.toPlain(customer), [...STRIP_BASE, '_id']);

    const strip = (items: any[]) =>
      items.map((item) => this.stripFields(this.toPlain(item), [...STRIP_BASE, ...STRIP_OWNER]));

    // Secrets: redact encrypted values unless explicitly requested. Even with
    // include=true we export the encrypted blob (recipient must share the
    // SECRETS_ENCRYPTION_KEY to decrypt) — never the plaintext.
    const exportedSecrets = secrets.map((s: any) => {
      const plain = this.stripFields(this.toPlain(s), [...STRIP_BASE, ...STRIP_OWNER]);
      if (!includeSecretValues) {
        plain.encryptedValue = null;
        plain._redacted = true;
      }
      return plain;
    });

    return {
      _exportVersion: 1,
      _exportedAt: new Date().toISOString(),
      _source: 'DevGrimoire',
      _includesSecretValues: includeSecretValues,
      customer: customerObj,
      contacts: strip(contacts),
      knowledge: strip(knowledge),
      todos: strip(todos),
      environments: strip(environments),
      secrets: exportedSecrets,
      research: strip(research),
      recurringTasks: strip(recurringTasks),
    };
  }

  async importCustomer(data: unknown, nameOverride?: string): Promise<CustomerImportResult> {
    if (!data || typeof data !== 'object') {
      throw new BadRequestException('Invalid customer export payload');
    }
    const exp = data as Partial<CustomerExport>;
    if (exp._exportVersion !== 1 || !exp.customer) {
      throw new BadRequestException(
        'Unsupported export version or missing customer record (expected _exportVersion=1)',
      );
    }

    const warnings: string[] = [];
    const customerSrc = exp.customer as Record<string, unknown>;
    const targetName = nameOverride?.trim() || (customerSrc.name as string);
    if (!targetName) throw new BadRequestException('Customer name missing in export');

    // Disambiguate name on collision rather than failing — easier to recover.
    let finalName = targetName;
    let suffix = 0;
    while (await this.customerModel.exists({ name: finalName })) {
      suffix += 1;
      finalName = `${targetName} (Import ${suffix})`;
    }
    if (finalName !== targetName) {
      warnings.push(`Name collision — imported as "${finalName}".`);
    }

    const created = await this.customersService.create({
      name: finalName,
      description: customerSrc.description as string | undefined,
      status: customerSrc.status as never,
      tags: (customerSrc.tags as string[] | undefined) ?? [],
      primaryContactName: customerSrc.primaryContactName as string | undefined,
      primaryContactEmail: customerSrc.primaryContactEmail as string | undefined,
      primaryContactPhone: customerSrc.primaryContactPhone as string | undefined,
      website: customerSrc.website as string | undefined,
      notes: customerSrc.notes as string | undefined,
    } as never);
    const newCustomerId = created._id;

    const counts = {
      contacts: 0,
      knowledge: 0,
      todos: 0,
      environments: 0,
      secrets: 0,
      research: 0,
      recurringTasks: 0,
    };

    // Direct insertMany with rewritten customerId — bypasses service-layer
    // validation (no projectId-coupling for these), which is intentional for
    // a bulk import. Service-layer events would fire too eagerly anyway.
    const insertOwned = async <T>(items: any[] | undefined, model: Model<any>, label: keyof typeof counts) => {
      if (!items || items.length === 0) return;
      const docs = items.map((item) => {
        const copy = { ...item };
        delete copy._id; // let Mongo assign new ids
        copy.customerId = newCustomerId;
        return copy;
      });
      try {
        const inserted = await model.insertMany(docs, { ordered: false });
        counts[label] = inserted.length;
      } catch (err) {
        warnings.push(`Partial import for ${String(label)}: ${(err as Error).message}`);
      }
    };

    await Promise.all([
      insertOwned(exp.contacts, this.contactModel, 'contacts'),
      insertOwned(exp.knowledge, this.knowledgeModel, 'knowledge'),
      insertOwned(exp.environments, this.environmentModel, 'environments'),
      insertOwned(exp.research, this.researchModel, 'research'),
      insertOwned(exp.recurringTasks, this.recurringTaskModel, 'recurringTasks'),
    ]);

    // Todos need a fresh number sequence per customer — strip the source
    // numbers, the count remains. The counter service will re-issue numbers
    // on next interactive create. Here we keep the imported todos numberless,
    // which is rare-edge but acceptable for a v1 import.
    if (exp.todos && exp.todos.length > 0) {
      const todoDocs = exp.todos.map((t: any, i: number) => ({
        ...t,
        _id: undefined,
        customerId: newCustomerId,
        // Re-issue number based on import order; collisions later are unlikely
        // because customer is new and counter starts at 0.
        number: i + 1,
        displayNumber: `T-${i + 1}`,
      }));
      try {
        const inserted = await this.todoModel.insertMany(todoDocs, { ordered: false });
        counts.todos = inserted.length;
      } catch (err) {
        warnings.push(`Partial import for todos: ${(err as Error).message}`);
      }
    }

    // Secrets: only import if encryptedValue present (redacted exports skip).
    if (exp.secrets && exp.secrets.length > 0) {
      const usable = exp.secrets.filter((s: any) => s.encryptedValue && !s._redacted);
      if (usable.length < exp.secrets.length) {
        warnings.push(
          `${exp.secrets.length - usable.length} secret(s) skipped (export was redacted; re-export with includeSecretValues=true to migrate values).`,
        );
      }
      if (usable.length > 0) {
        const docs = usable.map((s: any) => {
          const copy = { ...s };
          delete copy._id;
          delete copy._redacted;
          copy.customerId = newCustomerId;
          return copy;
        });
        try {
          const inserted = await this.secretModel.insertMany(docs, { ordered: false });
          counts.secrets = inserted.length;
        } catch (err) {
          warnings.push(`Partial import for secrets: ${(err as Error).message}`);
        }
      }
    }

    return {
      customerId: newCustomerId.toString(),
      imported: counts,
      warnings,
    };
  }

  private toPlain(doc: any): Record<string, unknown> {
    if (doc && typeof doc.toObject === 'function') return doc.toObject();
    return { ...doc };
  }

  private stripFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
    const result = { ...obj };
    for (const f of fields) delete result[f];
    if (result._id) result._id = result._id.toString();
    return result;
  }
}
