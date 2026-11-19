import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CustomersService } from '../customers/customers.service';
import { ContactsService } from '../contacts/contacts.service';
import {
  Customer,
  CustomerDocument,
  CustomerStatus,
} from '../customers/schemas/customer.schema';
import { Contact, ContactDocument } from '../contacts/schemas/contact.schema';
import { Knowledge, KnowledgeDocument } from '../knowledge/schemas/knowledge.schema';
import { Todo, TodoDocument } from '../todos/schemas/todo.schema';
import { Environment, EnvironmentDocument } from '../environments/schemas/environment.schema';
import { Secret, SecretDocument } from '../secrets/schemas/secret.schema';
import { Research, ResearchDocument } from '../research/schemas/research.schema';
import { RecurringTask, RecurringTaskDocument } from '../recurring-tasks/schemas/recurring-task.schema';
import { asString, idToString, isUnknownArray, PlainDoc } from '../common/tool-args';
import { CustomerExport, CustomerImportResult } from './customer-export.interface';
import { assertOwnerPermission, assertUnrestrictedScope, scopeFilter } from '../common/scope-guard';
import { RequestContext } from '../common/request-context';

const STRIP_BASE = ['__v'];
const STRIP_OWNER = ['customerId', 'projectId'];

/** Die Abschnitte des Export-Formats, die Listen von Dokumenten tragen. */
type SectionName = keyof CustomerImportResult['imported'];

const CUSTOMER_STATUSES = Object.values(CustomerStatus);

/*
 * Per-section import allowlists. Only content fields — never owner fields
 * (projectId, customerId, scope), ownership/user references (ownedBy*,
 * createdByUserId, ownerUserId) or references to other entities, which would
 * point into data the importing actor may not control. Nested subdocuments
 * (comments, variables, acceptanceCriteria …) are cleaned by their Mongoose
 * sub-schemas in strict mode.
 */
const CONTACT_FIELDS = ['name', 'role', 'email', 'phone', 'notes', 'isPrimary', 'sortOrder'] as const;
const KNOWLEDGE_FIELDS = ['topic', 'content', 'tags', 'category', 'sensitivity'] as const;
const TODO_FIELDS = [
  'title', 'description', 'status', 'priority', 'tags', 'comments', 'repoLabel', 'archived',
  'userStories', 'acceptanceCriteria', 'outOfScope', 'edgeCases',
] as const;
const ENV_FIELDS = ['name', 'description', 'host', 'port', 'user', 'url', 'variables', 'active'] as const;
const SECRET_FIELDS = ['key', 'encryptedValue', 'description', 'type'] as const;
const RESEARCH_FIELDS = [
  'title', 'content', 'sources', 'tags', 'sensitivity', 'focus', 'depth', 'files', 'tasks',
  'followUps', 'sourceList', 'model', 'roundsDone', 'totalMs', 'startedAt', 'finishedAt',
] as const;
const RECURRING_FIELDS = [
  'title', 'description', 'priority', 'tags', 'repoLabel', 'frequency', 'dayOfWeek', 'dayOfMonth',
  'month', 'hour', 'active', 'nextRun', 'maxCatchUp', 'action', 'chat',
] as const;

/** Copies only the allowlisted fields that are present in the source. */
function pickFields(src: PlainDoc, fields: readonly string[]): PlainDoc {
  const out: PlainDoc = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(src, field) && src[field] !== undefined) {
      out[field] = src[field];
    }
  }
  return out;
}

/**
 * Objekt mit String-Keys. Als Prädikat statt als Behauptung: `unknown` zu
 * `Record<string, unknown>` zu verengen ist sachlich richtig (jeder Zugriff
 * liefert wieder `unknown`), und ein `is`-Prädikat bindet diese Verengung an
 * eine echte Laufzeitprüfung, statt sie nur zu behaupten.
 */
function isRecord(value: unknown): value is PlainDoc {
  return value !== null && typeof value === 'object';
}

/**
 * `toObject`-Aufruf ohne Argumente.
 *
 * Warum ein Prädikat und nicht `typeof x === 'function'` direkt: das verengt nur
 * zu `Function`, und `Function.call` gibt `any` zurück — damit wäre die ganze
 * `no-unsafe-*`-Familie wieder im Spiel. Das Prädikat sagt genau das aus, was
 * hier gebraucht wird: aufrufbar ohne Argumente, Rückgabe ungeprüft.
 */
function isNullaryMethod(value: unknown): value is () => unknown {
  return typeof value === 'function';
}

/**
 * Roh-Variante von `toPlainDoc` aus `common/tool-args.ts`: `toObject` statt
 * `toJSON`.
 *
 * Der Unterschied ist hier der ganze Punkt. `toJSON` läuft durch die
 * Schema-Transforms; für einen Transfer muss das Dokument aber so herauskommen,
 * wie es in der DB steht, sonst fehlen beim Import genau die Felder, die ein
 * Transform ausblendet. `project-transfer.service.ts` hat aus demselben Grund
 * dieselbe lokale Variante.
 *
 * `toObject` wird per Duck-Typing geprüft, damit `lean()`-Ergebnisse (Plain
 * Objects) und hydrierte Dokumente denselben Weg nehmen.
 */
function toRawDoc(doc: unknown): PlainDoc {
  if (!isRecord(doc)) return {};
  const toObject = doc.toObject;
  if (isNullaryMethod(toObject)) {
    const plain = toObject.call(doc);
    if (isRecord(plain)) return { ...plain };
  }
  return { ...doc };
}

/** Ein Objekt (kein Array, kein null) als `PlainDoc` — sonst `undefined`. */
function asPlainDoc(value: unknown): PlainDoc | undefined {
  return isRecord(value) && !Array.isArray(value) ? value : undefined;
}

/**
 * Ein Listen-Abschnitt des Exports. Fehlt er, ist die Liste leer — wie vorher
 * (`if (!items) return`), ein Export ohne z.B. `research` bleibt gültig.
 *
 * Ein vorhandener, aber falsch geformter Abschnitt bricht dagegen laut ab.
 * Vorher lief er ungeprüft in `items.map(item => ({ ...item }))`: ein String
 * `"ab"` wurde per Spread zu `{ 0: 'a', 1: 'b' }` und landete als leeres
 * Dokument in der Collection, ein Objekt statt eines Arrays warf mitten im
 * Import einen TypeError (HTTP 500) — beides, nachdem der Kunde schon angelegt
 * war. Nicht-Objekte werden bewusst NICHT still herausgefiltert: das würde
 * Nutzerdaten verlieren, ohne dass es jemand merkt.
 */
function exportedDocs(value: unknown, field: string): PlainDoc[] {
  if (value === undefined || value === null) return [];
  if (!isUnknownArray(value)) {
    throw new BadRequestException(`Field "${field}" must be an array`);
  }
  return value.map((entry, index) => {
    const doc = asPlainDoc(entry);
    if (!doc) {
      throw new BadRequestException(`Field "${field}[${index}]" must be an object`);
    }
    return doc;
  });
}

/**
 * Verengt einen exportierten Wert auf einen Enum-Wert. `values.find()` liefert
 * den Enum-Typ direkt, es braucht also keine Behauptung.
 *
 * Fehlender Wert → `undefined`, damit der Schema-Default greift (wie vorher).
 * Vorhandener, aber unbekannter Wert → Fehler, damit er nicht still auf den
 * Default zurückfällt; vorher lief er als `as never` in die
 * Mongoose-Enum-Validierung und brach den Import ebenfalls ab.
 */
function asEnum<T extends string>(
  values: readonly T[],
  value: unknown,
  field: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = asString(value);
  const match = raw === undefined ? undefined : values.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new BadRequestException(
      `Invalid value for "${field}" in export: ${JSON.stringify(value)}`,
    );
  }
  return match;
}

/**
 * String-Liste aus dem Export (`customer.tags`). Nicht-Strings brechen ab statt
 * still zu verschwinden — verlorene Tags würde niemand bemerken.
 */
function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isUnknownArray(value)) {
    throw new BadRequestException(`Field "${field}" must be an array`);
  }
  return value.map((entry, index) => {
    const str = asString(entry);
    if (str === undefined) {
      throw new BadRequestException(`Field "${field}[${index}]" must be a string`);
    }
    return str;
  });
}

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
    // The bundle reads the raw collections, bypassing the per-resource checks
    // of the services — require every catalog read it contains up front.
    for (const resource of ['secret', 'knowledge', 'todo', 'contact'] as const) {
      assertOwnerPermission({ customerId }, resource, 'read');
    }
    const cid = new Types.ObjectId(customerId);
    // Relation documents (customerId + projectId) of projects outside the
    // actor's scope must not leak through the customer export. The customer
    // axis is already checked by findById; entities without projectId stay.
    const owned = (): Record<string, unknown> => Object.assign({ customerId: cid }, scopeFilter());

    const [contacts, knowledge, todos, environments, secrets, research, recurringTasks] =
      await Promise.all([
        this.contactModel.find(owned()).lean().exec(),
        this.knowledgeModel.find(owned()).lean().exec(),
        this.todoModel.find(owned()).lean().exec(),
        this.environmentModel.find(owned()).lean().exec(),
        this.secretModel.find(owned()).lean().exec(),
        this.researchModel.find(owned()).lean().exec(),
        this.recurringTaskModel.find(owned()).lean().exec(),
      ]);

    const customerObj = this.stripFields(toRawDoc(customer), [...STRIP_BASE, '_id']);

    const strip = (items: unknown[]): PlainDoc[] =>
      items.map((item) => this.stripFields(toRawDoc(item), [...STRIP_BASE, ...STRIP_OWNER]));

    // Secrets: redact encrypted values unless explicitly requested. Even with
    // include=true we export the encrypted blob (recipient must share the
    // SECRETS_ENCRYPTION_KEY to decrypt) — never the plaintext.
    const exportedSecrets = secrets.map((s) => {
      const plain = this.stripFields(toRawDoc(s), [...STRIP_BASE, ...STRIP_OWNER]);
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
    // The imported entity gets a new id that is not on a narrowed actor's
    // allowlist, so every follow-up create (environments, todos, knowledge …)
    // would fail its scope check and leave a half-imported, invisible entity.
    // Reject up front instead.
    assertUnrestrictedScope('Customer import');
    const exp = asPlainDoc(data);
    if (!exp) {
      throw new BadRequestException('Invalid customer export payload');
    }
    const customerSrc = asPlainDoc(exp.customer);
    if (exp._exportVersion !== 1 || !customerSrc) {
      throw new BadRequestException(
        'Unsupported export version or missing customer record (expected _exportVersion=1)',
      );
    }

    const warnings: string[] = [];
    const targetName = nameOverride?.trim() || asString(customerSrc.name);
    if (!targetName) throw new BadRequestException('Customer name missing in export');

    // Alle Abschnitte werden geprüft, *bevor* der Kunde angelegt wird. Vorher
    // schlug ein falsch geformter Abschnitt erst beim Einfügen fehl — der Kunde
    // war dann schon da und blieb ohne seine Daten zurück.
    const sections: Record<SectionName, PlainDoc[]> = {
      contacts: exportedDocs(exp.contacts, 'contacts'),
      knowledge: exportedDocs(exp.knowledge, 'knowledge'),
      todos: exportedDocs(exp.todos, 'todos'),
      environments: exportedDocs(exp.environments, 'environments'),
      secrets: exportedDocs(exp.secrets, 'secrets'),
      research: exportedDocs(exp.research, 'research'),
      recurringTasks: exportedDocs(exp.recurringTasks, 'recurringTasks'),
    };

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

    // Explizites Feld-Mapping ist hier vollständig: `CreateCustomerDto`
    // deklariert genau die Felder, die `Customer` hat. Es geht also nichts
    // verloren, und es braucht keine Behauptung an der Service-Grenze.
    const created = await this.customersService.create({
      name: finalName,
      description: asString(customerSrc.description),
      status: asEnum(CUSTOMER_STATUSES, customerSrc.status, 'customer.status'),
      tags: asStringArray(customerSrc.tags, 'customer.tags') ?? [],
      primaryContactName: asString(customerSrc.primaryContactName),
      primaryContactEmail: asString(customerSrc.primaryContactEmail),
      primaryContactPhone: asString(customerSrc.primaryContactPhone),
      website: asString(customerSrc.website),
      notes: asString(customerSrc.notes),
    });
    const newCustomerId = created._id;

    const counts: CustomerImportResult['imported'] = {
      contacts: 0,
      knowledge: 0,
      todos: 0,
      environments: 0,
      secrets: 0,
      research: 0,
      recurringTasks: 0,
    };

    // Direct insertMany — bypasses service-layer events, which would fire too
    // eagerly for a bulk import. Because the service-layer validation is
    // skipped, every document is REBUILT from an explicit per-section field
    // allowlist instead of copying the file's object: an uploaded export could
    // otherwise set `projectId` (planting data into a foreign project),
    // `scope: 'global'` (instance-wide knowledge), `ownedBy*` (hijacking SSH /
    // kube credentials), `createdByUserId` (a recurring chat task running as
    // another user) or references into foreign entities (milestoneId,
    // blockedBy, sourceQuestionId …). Owner fields are always forced.
    const actorUserId = RequestContext.getUser()?.userId;
    const importingUserId =
      actorUserId && Types.ObjectId.isValid(actorUserId) ? new Types.ObjectId(actorUserId) : undefined;

    // Environments get their new ids up front so secrets can be remapped onto
    // the imported environments instead of keeping stale source ids.
    const envIdMap = new Map<string, Types.ObjectId>();
    const envDocs = sections.environments.map((src) => {
      const doc = pickFields(src, ENV_FIELDS);
      const newId = new Types.ObjectId();
      const sourceId = idToString(src._id);
      if (sourceId !== undefined) envIdMap.set(sourceId, newId);
      return { ...doc, _id: newId, customerId: newCustomerId };
    });

    const owned = (section: SectionName, fields: readonly string[]): PlainDoc[] =>
      sections[section].map((src) => ({ ...pickFields(src, fields), customerId: newCustomerId }));

    const insertSection = async (
      section: SectionName,
      docs: PlainDoc[],
      insert: (docs: PlainDoc[]) => Promise<unknown[]>,
    ): Promise<void> => {
      if (docs.length === 0) return;
      try {
        const inserted = await insert(docs);
        counts[section] = inserted.length;
      } catch (err) {
        warnings.push(`Partial import for ${section}: ${errorMessage(err)}`);
      }
    };

    const knowledgeDocs = owned('knowledge', KNOWLEDGE_FIELDS).map((doc) => ({
      ...doc,
      // Forced: the export only carries customer data; never restore `global`.
      scope: 'customer',
    }));

    const researchDocs = owned('research', RESEARCH_FIELDS).map((doc) => ({
      ...doc,
      // A queued/running status would hand the entry to the research runner.
      status: 'done',
      ownerUserId: importingUserId ?? null,
    }));

    let chatTasksDowngraded = 0;
    const recurringDocs = owned('recurringTasks', RECURRING_FIELDS).map((doc) => {
      // A chat task runs as `createdByUserId` — only ever the importing user.
      if (doc.action === 'chat' && !importingUserId) {
        chatTasksDowngraded += 1;
        const copy: PlainDoc = { ...doc, action: 'todo' };
        delete copy.chat;
        return copy;
      }
      return importingUserId ? { ...doc, createdByUserId: importingUserId } : doc;
    });
    if (chatTasksDowngraded > 0) {
      warnings.push(
        `${chatTasksDowngraded} recurring chat task(s) imported as todo tasks (no importing user to run them as).`,
      );
    }

    await Promise.all([
      insertSection('contacts', owned('contacts', CONTACT_FIELDS), (docs) =>
        this.contactModel.insertMany(docs, { ordered: false }),
      ),
      insertSection('knowledge', knowledgeDocs, (docs) =>
        this.knowledgeModel.insertMany(docs, { ordered: false }),
      ),
      insertSection('environments', envDocs, (docs) =>
        this.environmentModel.insertMany(docs, { ordered: false }),
      ),
      insertSection('research', researchDocs, (docs) =>
        this.researchModel.insertMany(docs, { ordered: false }),
      ),
      insertSection('recurringTasks', recurringDocs, (docs) =>
        this.recurringTaskModel.insertMany(docs, { ordered: false }),
      ),
    ]);

    // Todos need a fresh number sequence per customer — strip the source
    // numbers, the count remains. Re-issue numbers based on import order;
    // collisions later are unlikely because the customer is new.
    const todoDocs = owned('todos', TODO_FIELDS).map((doc, index) => ({
      ...doc,
      number: index + 1,
      displayNumber: `T-${index + 1}`,
    }));
    await insertSection('todos', todoDocs, (docs) =>
      this.todoModel.insertMany(docs, { ordered: false }),
    );

    // Secrets: only import if encryptedValue present (redacted exports skip).
    if (sections.secrets.length > 0) {
      const usable = sections.secrets.filter(
        (s) => typeof s.encryptedValue === 'string' && s.encryptedValue !== '' && !s._redacted,
      );
      if (usable.length < sections.secrets.length) {
        warnings.push(
          `${sections.secrets.length - usable.length} secret(s) skipped (export was redacted; re-export with includeSecretValues=true to migrate values).`,
        );
      }
      const secretDocs = usable.map((src) => {
        // Remap onto an imported environment; an unknown id falls back to a
        // customer-wide secret instead of pointing at a foreign environment.
        const sourceEnvId = idToString(src.environmentId);
        const envId = sourceEnvId !== undefined ? envIdMap.get(sourceEnvId) : undefined;
        return {
          ...pickFields(src, SECRET_FIELDS),
          customerId: newCustomerId,
          environmentId: envId ? envId.toString() : null,
        };
      });
      await insertSection('secrets', secretDocs, (docs) =>
        this.secretModel.insertMany(docs, { ordered: false }),
      );
    }

    return {
      customerId: newCustomerId.toString(),
      imported: counts,
      warnings,
    };
  }

  private stripFields(obj: PlainDoc, fields: readonly string[]): PlainDoc {
    const result = { ...obj };
    for (const f of fields) delete result[f];
    // JSON kennt keine ObjectId, also muss jede ID beim Export ein String
    // werden (der Import castet sie über Mongoose zurück). `idToString` liefert
    // `undefined` statt `'[object Object]'`, wenn dort etwas steht, das keine ID
    // ist — vorher hätte `result._id.toString()` genau diesen Text exportiert.
    const id = idToString(result._id);
    if (id !== undefined) result._id = id;
    return result;
  }
}
