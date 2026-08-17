import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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

const STRIP_BASE = ['__v'];
const STRIP_OWNER = ['customerId', 'projectId'];

/** Die Abschnitte des Export-Formats, die Listen von Dokumenten tragen. */
type SectionName = keyof CustomerImportResult['imported'];

const CUSTOMER_STATUSES = Object.values(CustomerStatus);

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

/**
 * Meldungstext eines unbekannten Wurfs. Vorher stand hier `(err as Error).message`
 * — bei allem, was kein `Error` ist, war das `undefined`, und die Warnung an den
 * Benutzer lautete wörtlich „Partial import for todos: undefined".
 *
 * Kein `JSON.stringify` als Rückfall: das wirft bei einem zyklischen Objekt, und
 * zwar hier im `catch`-Zweig, wo der Fehler dann die Antwort mitnimmt.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const str = asString(err);
  if (str !== undefined) return str;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  return 'unknown error';
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

    // Direct insertMany with rewritten customerId — bypasses service-layer
    // validation (no projectId-coupling for these), which is intentional for
    // a bulk import. Service-layer events would fire too eagerly anyway.
    //
    // Das Modell kommt als Closure herein statt als `Model<any>`: so bleibt an
    // jeder Aufrufstelle das konkret typisierte Modell sichtbar und geprüft.
    const insertOwned = async (
      section: SectionName,
      insert: (docs: PlainDoc[]) => Promise<unknown[]>,
    ): Promise<void> => {
      const items = sections[section];
      if (items.length === 0) return;
      const docs = items.map((item) => {
        const copy = { ...item };
        delete copy._id; // let Mongo assign new ids
        copy.customerId = newCustomerId;
        return copy;
      });
      try {
        const inserted = await insert(docs);
        counts[section] = inserted.length;
      } catch (err) {
        warnings.push(`Partial import for ${section}: ${errorMessage(err)}`);
      }
    };

    await Promise.all([
      insertOwned('contacts', (docs) => this.contactModel.insertMany(docs, { ordered: false })),
      insertOwned('knowledge', (docs) => this.knowledgeModel.insertMany(docs, { ordered: false })),
      insertOwned('environments', (docs) =>
        this.environmentModel.insertMany(docs, { ordered: false }),
      ),
      insertOwned('research', (docs) => this.researchModel.insertMany(docs, { ordered: false })),
      insertOwned('recurringTasks', (docs) =>
        this.recurringTaskModel.insertMany(docs, { ordered: false }),
      ),
    ]);

    // Todos need a fresh number sequence per customer — strip the source
    // numbers, the count remains. The counter service will re-issue numbers
    // on next interactive create. Here we keep the imported todos numberless,
    // which is rare-edge but acceptable for a v1 import.
    if (sections.todos.length > 0) {
      const todoDocs = sections.todos.map((todo, index) => {
        const copy = { ...todo };
        // `delete` statt `_id: undefined`: eine eigene Property mit `undefined`
        // hängt davon ab, dass Mongoose sie beim Casten überspringt und den
        // `_id`-Default nachzieht. Löschen sagt dasselbe ohne die Annahme.
        delete copy._id;
        copy.customerId = newCustomerId;
        // Re-issue number based on import order; collisions later are unlikely
        // because customer is new and counter starts at 0.
        copy.number = index + 1;
        copy.displayNumber = `T-${index + 1}`;
        return copy;
      });
      try {
        const inserted = await this.todoModel.insertMany(todoDocs, { ordered: false });
        counts.todos = inserted.length;
      } catch (err) {
        warnings.push(`Partial import for todos: ${errorMessage(err)}`);
      }
    }

    // Secrets: only import if encryptedValue present (redacted exports skip).
    if (sections.secrets.length > 0) {
      const usable = sections.secrets.filter((s) => Boolean(s.encryptedValue) && !s._redacted);
      if (usable.length < sections.secrets.length) {
        warnings.push(
          `${sections.secrets.length - usable.length} secret(s) skipped (export was redacted; re-export with includeSecretValues=true to migrate values).`,
        );
      }
      if (usable.length > 0) {
        const docs = usable.map((s) => {
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
          warnings.push(`Partial import for secrets: ${errorMessage(err)}`);
        }
      }
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
