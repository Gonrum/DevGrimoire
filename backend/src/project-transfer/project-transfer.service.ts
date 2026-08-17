import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProjectsService } from '../projects/projects.service';
import { TodosService } from '../todos/todos.service';
import { SessionsService } from '../sessions/sessions.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ChangelogService } from '../changelog/changelog.service';
import { MilestonesService } from '../milestones/milestones.service';
import { EnvironmentsService } from '../environments/environments.service';
import { SecretsService } from '../secrets/secrets.service';
import { ManualsService } from '../manuals/manuals.service';
import { ResearchService } from '../research/research.service';
import { SchemasService } from '../schemas/schemas.service';
import { DependenciesService } from '../dependencies/dependencies.service';
import { FeaturesService } from '../features/features.service';
import { CountersService } from '../counters/counters.service';
import { Secret, SecretDocument } from '../secrets/schemas/secret.schema';
import { CreateEnvironmentDto } from '../environments/dto/create-environment.dto';
import { CreateChangelogDto } from '../changelog/dto/create-changelog.dto';
import { CreateMilestoneDto } from '../milestones/dto/create-milestone.dto';
import { AcceptanceCriterionDto, CreateTodoDto } from '../todos/dto/create-todo.dto';
import { UpdateTodoDto } from '../todos/dto/update-todo.dto';
import { CreateSessionDto } from '../sessions/dto/create-session.dto';
import { CreateKnowledgeDto } from '../knowledge/dto/create-knowledge.dto';
import { CreateResearchDto } from '../research/dto/create-research.dto';
import { CreateManualDto } from '../manuals/dto/create-manual.dto';
import { CreateSchemaDto, SchemaFieldDto, SchemaIndexDto } from '../schemas/dto/create-schema.dto';
import { CreateDependencyDto } from '../dependencies/dto/create-dependency.dto';
import { CreateFeatureDto } from '../features/dto/create-feature.dto';
import { TodoStatus, TodoPriority } from '../todos/schemas/todo.schema';
import { MilestoneStatus } from '../milestones/schemas/milestone.schema';
import { DbType } from '../schemas/schemas/db-schema.schema';
import { PackageManager } from '../dependencies/schemas/dependency.schema';
import { FeatureStatus, FeaturePriority } from '../features/schemas/feature.schema';
import { ALL_SENSITIVITY_LEVELS } from '../common/sensitivity';
import { asString, isNullaryMethod, isRecord, isUnknownArray, PlainDoc } from '../common/tool-args';
import { ProjectExport } from './project-export.interface';

/*
 * Datentransfer-Pfad. Zwei Regeln gelten hier über allem anderen:
 *
 * 1. **Nichts still verwerfen.** Was im Export steht, muss beim Import ankommen
 *    oder mit Begründung abgelehnt werden — aber nie unbemerkt fehlen.
 * 2. **Prüfen, bevor geschrieben wird.** Der Import legt zwölf Collections
 *    hintereinander an; ein Formfehler, der erst beim zehnten Schreibvorgang
 *    auffliegt, hinterlässt ein halb importiertes Projekt.
 *
 * Aus 2. folgt die Zweiteilung von `importProject`: Phase 1 liest den Export
 * vollständig in getypte Eingaben, Phase 2 schreibt nur noch. Damit Phase 2 gar
 * nicht in Versuchung kommt, wieder in die Rohdaten zu greifen, trägt
 * `Prepared` das Quell-Dokument bewusst NICHT mit — nur den Map-Schlüssel und
 * die (nie werfende) Nummer für die Zähler-Sequenz.
 */

/**
 * Normalisiert Mongoose-Dokumente und Plain Objects (lean(), JSON.parse) auf
 * dieselbe Form. Bewusst `toObject` per Duck-Typing statt `toJSON` — `toJSON`
 * würde Schema-Transforms anwenden, und was ein Transform ausblendet, fehlte im
 * Export und wäre beim Import verloren.
 *
 * Zwei Prädikate statt drei Assertions: `isRecord` erlaubt den Feldzugriff, und
 * `isNullaryMethod` sagt das Schwächste, worauf sich der Aufruf verlässt — ein
 * blankes `typeof === 'function'` verengt nur zu `Function`, dessen `.call()`
 * wieder `any` liefert.
 */
function toPlainDoc(doc: unknown): PlainDoc {
  if (!isRecord(doc)) return {};
  const toObject = doc.toObject;
  if (isNullaryMethod(toObject)) {
    const plain: unknown = toObject.call(doc);
    if (isRecord(plain)) return { ...plain };
  }
  return { ...doc };
}

/** Ein Objekt (kein Array, kein null) als `PlainDoc` — sonst `undefined`. */
function asPlainDoc(value: unknown): PlainDoc | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * ObjectId als Hex-String. JSON kennt keine ObjectId, deshalb muss jede ID beim
 * Export zu einem String werden und beim Import wieder gecastet (das macht
 * Mongoose beim Schreiben). Bereits konvertierte Strings kommen unverändert
 * zurück; alles andere ergibt `undefined` statt eines '[object Object]'-Strings.
 */
function idAsString(value: unknown): string | undefined {
  if (value instanceof Types.ObjectId) return value.toHexString();
  return asString(value);
}

/**
 * Map-Key für die Referenz-Umschreibung beim Import. Die exportierte `_id` ist
 * immer ein String; fehlt sie, tritt die Array-Position als Ersatzschlüssel ein,
 * damit zwei Einträge ohne `_id` sich nicht gegenseitig überschreiben. Ein
 * `#`-Key kollidiert nie mit einer Hex-ObjectId.
 */
function exportKey(doc: PlainDoc, index: number): string {
  return idAsString(doc._id) ?? `#${index}`;
}

/** Kopie ohne die genannten Felder, `_id` als String. */
function stripFields(obj: PlainDoc, fields: readonly string[]): PlainDoc {
  const result = { ...obj };
  for (const f of fields) delete result[f];
  // Convert ObjectId to string
  const id = idAsString(result._id);
  if (id !== undefined) result._id = id;
  return result;
}

// ---------------------------------------------------------------------------
// Leser für exportierte Werte
//
// Alle folgenden Helfer verengen mit einer Laufzeitprüfung statt mit einer
// Behauptung. Ein `doc.title as string` sagte nichts über den Wert; passte er
// nicht, entschied Mongoose: entweder stille Coercion (aus der Zahl 5 wurde
// "5") oder ein Validierungsfehler mitten im Import, also HTTP 500 auf einem
// halb geschriebenen Projekt. Jetzt gibt es ein 400 mit dem Feldpfad, bevor
// irgendetwas geschrieben ist.
// ---------------------------------------------------------------------------

function invalid(path: string, expected: string): BadRequestException {
  return new BadRequestException(`Field "${path}" must be ${expected}`);
}

/**
 * Ein Listen-Abschnitt des Exports. Fehlt er, ist die Liste leer — ein Export
 * ohne z.B. `features` bleibt damit gültig; vorher lief er in ein
 * `for (… of undefined)` und riss den Import mit HTTP 500 ab, *nachdem* das
 * Projekt schon angelegt war.
 *
 * Ein vorhandener, aber falsch geformter Abschnitt bricht dagegen laut ab.
 * Nicht-Objekte werden bewusst NICHT herausgefiltert: das würde Nutzerdaten
 * verlieren, ohne dass es jemand merkt.
 */
function exportedDocs(value: unknown, field: string): PlainDoc[] {
  if (value === undefined || value === null) return [];
  if (!isUnknownArray(value)) throw invalid(field, 'an array');
  return value.map((entry, index) => {
    const doc = asPlainDoc(entry);
    if (!doc) throw invalid(`${field}[${index}]`, 'an object');
    return doc;
  });
}

/** Pflichtfeld: nicht-leerer String. Genau das, was Mongoose `required` fordert. */
function reqString(doc: PlainDoc, field: string, at: string): string {
  const value = asString(doc[field]);
  if (value === undefined || value === '') throw invalid(`${at}.${field}`, 'a non-empty string');
  return value;
}

/** Optionaler String. Fehlt er, greift der Schema-Default. */
function optString(doc: PlainDoc, field: string, at: string): string | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  const str = asString(value);
  if (str === undefined) throw invalid(`${at}.${field}`, 'a string');
  return str;
}

/**
 * Optionales Datum als ISO-String. Ein JSON-Export trägt hier einen String; ein
 * direkt aus `toObject()` gereichtes Dokument ein `Date`. Beide Formen gelten,
 * damit der Wert nicht an der Herkunft der Daten scheitert.
 */
function optDateString(doc: PlainDoc, field: string, at: string): string | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  const str = asString(value);
  if (str === undefined) throw invalid(`${at}.${field}`, 'a date string');
  return str;
}

/**
 * Referenz-ID als String. Ein JSON-Export trägt hier den Hex-String (BSONs
 * `ObjectId.toJSON` liefert ihn), ein direkt gereichtes Dokument eine echte
 * ObjectId — beide Formen gelten, damit eine Referenz nicht an der Herkunft der
 * Daten scheitert.
 */
function optIdString(doc: PlainDoc, field: string, at: string): string | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  const id = idAsString(value);
  if (id === undefined) throw invalid(`${at}.${field}`, 'an id string');
  return id;
}

/** Liste von Referenz-IDs (`todo.blockedBy`). */
function optIdList(doc: PlainDoc, field: string, at: string): string[] | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  if (!isUnknownArray(value)) throw invalid(`${at}.${field}`, 'an array');
  return value.map((entry, index) => {
    const id = idAsString(entry);
    if (id === undefined) throw invalid(`${at}.${field}[${index}]`, 'an id string');
    return id;
  });
}

function optNumber(doc: PlainDoc, field: string, at: string): number | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${at}.${field}`, 'a number');
  }
  return value;
}

function optBoolean(doc: PlainDoc, field: string, at: string): boolean | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${at}.${field}`, 'a boolean');
  return value;
}

/**
 * String-Liste aus dem Export (tags, changes, sources …). Nicht-Strings brechen
 * ab statt still zu verschwinden — verlorene Tags würde niemand bemerken.
 */
function optStringList(doc: PlainDoc, field: string, at: string): string[] | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  if (!isUnknownArray(value)) throw invalid(`${at}.${field}`, 'an array');
  return value.map((entry, index) => {
    const str = asString(entry);
    if (str === undefined) throw invalid(`${at}.${field}[${index}]`, 'a string');
    return str;
  });
}

/**
 * Verengt einen exportierten Wert auf einen Enum-Wert — ohne Behauptung, weil
 * `values.find()` schon den Enum-Typ liefert. Unbekannte Werte ergeben
 * `undefined`, ohne zu werfen.
 */
function matchEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
  const raw = asString(value);
  return raw === undefined ? undefined : values.find((candidate) => candidate === raw);
}

/**
 * Wie `matchEnum`, aber laut: Fehlender Wert → `undefined`, damit der
 * Schema-Default greift. Vorhandener, aber unbekannter Wert → Fehler, damit er
 * nicht still auf den Default zurückfällt; vorher lief er in die
 * Mongoose-Enum-Validierung und brach den Import ebenfalls ab, nur später.
 */
function optEnum<T extends string>(
  values: readonly T[],
  doc: PlainDoc,
  field: string,
  at: string,
): T | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  const match = matchEnum(values, value);
  if (match === undefined) {
    throw new BadRequestException(
      `Invalid value for "${at}.${field}" in export: ${JSON.stringify(value)}`,
    );
  }
  return match;
}

/**
 * Liste verschachtelter Objekte, **unverändert** durchgereicht.
 *
 * Der Rückgabewert ist dasselbe Objekt, das im Export stand — das ist hier der
 * ganze Punkt: Die Mongoose-Schemata für `environments.variables` (Subdokument
 * mit eigener `_id`) und `schemas.fields`/`schemas.indexes` (`[Object]`, also
 * formfrei) tragen mehr Felder als die DTO-Klassen deklarieren. Ein Neuaufbau
 * Feld für Feld würde genau die verlieren. Geprüft wird deshalb nur, was der
 * Ziel-Typ verspricht; alles darüber hinaus reist unangetastet mit.
 */
function optList<T>(
  doc: PlainDoc,
  field: string,
  at: string,
  isElement: (entry: unknown) => entry is T,
  expected: string,
): T[] | undefined {
  const value = doc[field];
  if (value === undefined || value === null) return undefined;
  if (!isUnknownArray(value)) throw invalid(`${at}.${field}`, 'an array');
  return value.map((entry, index) => {
    if (!isElement(entry)) throw invalid(`${at}.${field}[${index}]`, expected);
    return entry;
  });
}

/** Liste verschachtelter Objekte, feldweise gelesen (neues Objekt je Element). */
function readList<T>(
  doc: PlainDoc,
  field: string,
  at: string,
  read: (entry: PlainDoc, entryAt: string) => T,
): T[] {
  const value = doc[field];
  if (value === undefined || value === null) return [];
  if (!isUnknownArray(value)) throw invalid(`${at}.${field}`, 'an array');
  return value.map((entry, index) => {
    const entryAt = `${at}.${field}[${index}]`;
    const record = asPlainDoc(entry);
    if (!record) throw invalid(entryAt, 'an object');
    return read(record, entryAt);
  });
}

// `null` gilt wie „nicht gesetzt": ein Optional-Feld, das in der DB explizit auf
// null steht, soll den Import nicht scheitern lassen.
function isStringOrAbsent(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isBooleanOrAbsent(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean';
}

function isEnvVariable(entry: unknown): entry is { key: string; value: string } {
  return isRecord(entry) && typeof entry.key === 'string' && typeof entry.value === 'string';
}

function isAcceptanceCriterion(entry: unknown): entry is AcceptanceCriterionDto {
  return isRecord(entry) && typeof entry.text === 'string' && isBooleanOrAbsent(entry.done);
}

function isSchemaField(entry: unknown): entry is SchemaFieldDto {
  return (
    isRecord(entry) &&
    typeof entry.name === 'string' &&
    typeof entry.type === 'string' &&
    isBooleanOrAbsent(entry.nullable) &&
    isStringOrAbsent(entry.defaultValue) &&
    isStringOrAbsent(entry.description) &&
    isBooleanOrAbsent(entry.isPrimaryKey) &&
    isBooleanOrAbsent(entry.isIndexed) &&
    isStringOrAbsent(entry.reference)
  );
}

function isSchemaIndex(entry: unknown): entry is SchemaIndexDto {
  return (
    isRecord(entry) &&
    typeof entry.name === 'string' &&
    isUnknownArray(entry.fields) &&
    entry.fields.every((f) => typeof f === 'string') &&
    isBooleanOrAbsent(entry.unique) &&
    isStringOrAbsent(entry.type)
  );
}

/**
 * `number`-Feld für die Zähler-Sequenz. Bewusst tolerant und niemals werfend:
 * dieser Wert wird gelesen, *nachdem* alles geschrieben ist — eine kaputte
 * Nummer darf einen ansonsten erfolgreichen Import nicht in einen Fehler
 * verwandeln. Numerische Strings gelten wie vorher (dort über die JS-Coercion
 * in `Math.max`).
 */
function sequenceNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

const TODO_PRIORITIES = Object.values(TodoPriority);
const TODO_STATUS_ORDER: readonly TodoStatus[] = [
  TodoStatus.OPEN,
  TodoStatus.IN_PROGRESS,
  TodoStatus.REVIEW,
  TodoStatus.DONE,
];
const MILESTONE_STATUSES = Object.values(MilestoneStatus);
const DB_TYPES = Object.values(DbType);
const PACKAGE_MANAGERS = Object.values(PackageManager);
const FEATURE_STATUSES = Object.values(FeatureStatus);
const FEATURE_PRIORITIES = Object.values(FeaturePriority);

// ---------------------------------------------------------------------------
// Phase 1: Export-Abschnitte in getypte Eingaben lesen
//
// `projectId` und die Referenzfelder fehlen in den DTO-Typen — die kennt erst
// Phase 2, wenn die Zieldokumente existieren.
// ---------------------------------------------------------------------------

type EnvInput = Omit<CreateEnvironmentDto, 'projectId' | 'customerId'>;
type ChangelogInput = Omit<CreateChangelogDto, 'projectId'>;
type SessionInput = Omit<CreateSessionDto, 'projectId'>;
type KnowledgeInput = Omit<
  CreateKnowledgeDto,
  'projectId' | 'customerId' | 'scope' | 'sourceQuestionId'
>;
type ResearchInput = Omit<CreateResearchDto, 'projectId' | 'customerId'>;
type ManualInput = Omit<CreateManualDto, 'projectId' | 'customerId'>;
type SchemaInput = Omit<CreateSchemaDto, 'projectId'>;
type DependencyInput = Omit<CreateDependencyDto, 'projectId'>;
type FeatureInput = Omit<CreateFeatureDto, 'projectId'>;

/** Secrets gehen ohne Service-DTO direkt aufs Modell, brauchen also einen eigenen Typ. */
interface SecretInput {
  key: string;
  encryptedValue: string;
  description?: string;
  type: string;
  sourceEnvironmentId?: string;
}

/**
 * Milestones werden in zwei Schritten geschrieben: `create` kennt keinen Status,
 * und `done` verlangt eine Changelog-Referenz. Was der zweite Schritt braucht,
 * wird deshalb hier mitgelesen — nicht später aus dem Rohdokument.
 */
interface MilestoneInput {
  dto: Omit<CreateMilestoneDto, 'projectId' | 'status'>;
  /** Ob überhaupt ein Status im Export stand (unabhängig davon, ob er bekannt ist). */
  rawStatus?: string;
  status?: MilestoneStatus;
  archived?: boolean;
  sourceChangelogId?: string;
}

interface TodoCommentInput {
  text: string;
  author: string;
}

/** Wie MilestoneInput: alles, was der zweite Durchlauf braucht, steht hier. */
interface TodoInput {
  dto: Omit<
    CreateTodoDto,
    'projectId' | 'customerId' | 'status' | 'milestoneId' | 'blockedBy' | 'openQuestions'
  >;
  sourceMilestoneId?: string;
  sourceBlockedBy?: string[];
  rawStatus?: string;
  archived?: boolean;
  comments: TodoCommentInput[];
}

/** Ein gelesener Abschnitts-Eintrag. */
interface Prepared<T> {
  /** Schlüssel des Quell-Dokuments für die ID-Maps. */
  key: string;
  /** `number` des Quell-Dokuments — nur für die Zähler-Sequenz am Ende. */
  sequence: number;
  input: T;
}

function prepareEnvironment(src: PlainDoc, at: string): EnvInput {
  return {
    name: reqString(src, 'name', at),
    // description/host/port/user/url wurden vorher nicht importiert: die Felder
    // standen im Export, der Import reichte sie aber nicht an das DTO weiter und
    // sie fehlten danach still. Verbindungsdaten eines Environments sind kein
    // Beiwerk — das war Datenverlust.
    description: optString(src, 'description', at),
    host: optString(src, 'host', at),
    port: optNumber(src, 'port', at),
    user: optString(src, 'user', at),
    url: optString(src, 'url', at),
    variables: optList(
      src,
      'variables',
      at,
      isEnvVariable,
      'an object with string "key" and "value"',
    ),
    active: optBoolean(src, 'active', at) ?? true,
  };
}

/**
 * Ein Secret ohne `encryptedValue` (Metadaten-Export) ist nicht rekonstruierbar
 * und wird übersprungen — `undefined` steht für „nicht importierbar". Die
 * Statistik zählt entsprechend nur die tatsächlich importierten.
 */
function prepareSecret(src: PlainDoc, at: string): SecretInput | undefined {
  const encryptedValue = optString(src, 'encryptedValue', at);
  if (!encryptedValue) return undefined;
  return {
    key: reqString(src, 'key', at),
    encryptedValue,
    description: optString(src, 'description', at),
    type: optString(src, 'type', at) || 'variable',
    sourceEnvironmentId: optIdString(src, 'environmentId', at),
  };
}

function prepareChangelog(src: PlainDoc, at: string): ChangelogInput {
  return {
    version: optString(src, 'version', at),
    // `changes` ist im DTO Pflicht, im Schema mit Default [] — ein Export ohne
    // das Feld bleibt damit gültig, wie vorher.
    changes: optStringList(src, 'changes', at) ?? [],
    summary: optString(src, 'summary', at),
    component: optString(src, 'component', at),
    // repoLabel ging vorher still verloren.
    repoLabel: optString(src, 'repoLabel', at),
  };
}

function prepareMilestone(src: PlainDoc, at: string): MilestoneInput {
  const rawStatus = optString(src, 'status', at);
  return {
    dto: {
      name: reqString(src, 'name', at),
      description: optString(src, 'description', at),
      dueDate: optDateString(src, 'dueDate', at),
    },
    rawStatus,
    // Unbekannte Status-Werte laufen wie vorher in den Zweig ohne
    // Status-Änderung, statt den Import abzubrechen — deshalb `matchEnum` und
    // nicht `optEnum`.
    status: matchEnum(MILESTONE_STATUSES, rawStatus),
    archived: optBoolean(src, 'archived', at),
    sourceChangelogId: optIdString(src, 'changelogId', at),
  };
}

function prepareTodo(src: PlainDoc, at: string): TodoInput {
  return {
    dto: {
      title: reqString(src, 'title', at),
      description: optString(src, 'description', at),
      priority: optEnum(TODO_PRIORITIES, src, 'priority', at),
      tags: optStringList(src, 'tags', at),
      // Diese fünf Felder standen im Export, wurden aber nicht importiert. Bei
      // `acceptanceCriteria` war das der schwerste Verlust: die Kriterien sind
      // im Todo-Workflow der Maßstab für „done" und waren nach einem Transfer
      // weg.
      repoLabel: optString(src, 'repoLabel', at),
      userStories: optString(src, 'userStories', at),
      outOfScope: optString(src, 'outOfScope', at),
      edgeCases: optString(src, 'edgeCases', at),
      acceptanceCriteria: optList(
        src,
        'acceptanceCriteria',
        at,
        isAcceptanceCriterion,
        'an object with a string "text"',
      ),
      // `openQuestions` bleibt bewusst draußen: die Referenzen zeigen auf
      // Question-Dokumente, die der Export nicht mitnimmt — importiert wären sie
      // Verweise ins Leere.
    },
    sourceMilestoneId: optIdString(src, 'milestoneId', at),
    sourceBlockedBy: optIdList(src, 'blockedBy', at),
    rawStatus: optString(src, 'status', at),
    archived: optBoolean(src, 'archived', at),
    comments: readList(src, 'comments', at, (comment, commentAt) => ({
      // Leerer Text bleibt erlaubt (wie vorher); ein Nicht-String wirft jetzt,
      // statt still zu einem leeren Kommentar zu werden.
      text: optString(comment, 'text', commentAt) ?? '',
      author: optString(comment, 'author', commentAt) || 'import',
    })),
  };
}

function prepareSession(src: PlainDoc, at: string): SessionInput {
  return {
    summary: reqString(src, 'summary', at),
    filesChanged: optStringList(src, 'filesChanged', at),
    nextSteps: optStringList(src, 'nextSteps', at),
    openQuestions: optStringList(src, 'openQuestions', at),
  };
}

function prepareKnowledge(src: PlainDoc, at: string): KnowledgeInput {
  return {
    topic: reqString(src, 'topic', at),
    content: reqString(src, 'content', at),
    tags: optStringList(src, 'tags', at),
    category: optString(src, 'category', at),
    // `sensitivity` ging vorher verloren und fiel damit auf den Default
    // `internal` zurück — ein als `confidential` markierter Eintrag wurde beim
    // Import RAG-indizierbar. Der Verlust war also nicht nur Kosmetik.
    sensitivity: optEnum(ALL_SENSITIVITY_LEVELS, src, 'sensitivity', at),
    // `scope` bleibt bewusst ungesetzt (Default `project`): der Export enthält
    // über `findByProject` auch globale Einträge, und die als `global`
    // wiederherzustellen würde bei jedem Import den globalen Bestand
    // verdoppeln. Das ist eine Produktentscheidung, keine Typfrage.
  };
}

function prepareResearch(src: PlainDoc, at: string): ResearchInput {
  return {
    title: reqString(src, 'title', at),
    content: reqString(src, 'content', at),
    sources: optStringList(src, 'sources', at),
    tags: optStringList(src, 'tags', at),
    // wie bei knowledge: ging vorher verloren
    sensitivity: optEnum(ALL_SENSITIVITY_LEVELS, src, 'sensitivity', at),
  };
}

function prepareManual(src: PlainDoc, at: string): ManualInput {
  return {
    title: reqString(src, 'title', at),
    content: optString(src, 'content', at),
    category: optString(src, 'category', at),
    sortOrder: optNumber(src, 'sortOrder', at),
    // ging vorher verloren (fiel auf den Default 'claude' zurück)
    lastEditedBy: optString(src, 'lastEditedBy', at),
  };
}

function prepareSchema(src: PlainDoc, at: string): SchemaInput {
  const dbType = optEnum(DB_TYPES, src, 'dbType', at);
  if (!dbType) {
    throw new BadRequestException(
      `Invalid export format: schema "${asString(src.name) ?? '?'}" has no dbType`,
    );
  }
  return {
    name: reqString(src, 'name', at),
    dbType,
    database: optString(src, 'database', at),
    description: optString(src, 'description', at),
    fields: optList(src, 'fields', at, isSchemaField, 'an object with string "name" and "type"'),
    indexes: optList(
      src,
      'indexes',
      at,
      isSchemaIndex,
      'an object with string "name" and string[] "fields"',
    ),
    tags: optStringList(src, 'tags', at),
  };
}

function prepareDependency(src: PlainDoc, at: string): DependencyInput {
  const packageManager = optEnum(PACKAGE_MANAGERS, src, 'packageManager', at);
  if (!packageManager) {
    throw new BadRequestException(
      `Invalid export format: dependency "${asString(src.name) ?? '?'}" has no packageManager`,
    );
  }
  return {
    name: reqString(src, 'name', at),
    version: reqString(src, 'version', at),
    packageManager,
    description: optString(src, 'description', at),
    devDependency: optBoolean(src, 'devDependency', at),
    category: optString(src, 'category', at),
    tags: optStringList(src, 'tags', at),
  };
}

function prepareFeature(src: PlainDoc, at: string): FeatureInput {
  return {
    name: reqString(src, 'name', at),
    description: optString(src, 'description', at),
    category: optString(src, 'category', at),
    status: optEnum(FEATURE_STATUSES, src, 'status', at),
    version: optString(src, 'version', at),
    priority: optEnum(FEATURE_PRIORITIES, src, 'priority', at),
    tags: optStringList(src, 'tags', at),
  };
}

/** Liest einen Abschnitt vollständig — Form, Felder und Map-Schlüssel. */
function prepareSection<T>(
  value: unknown,
  field: string,
  prepare: (src: PlainDoc, at: string) => T,
): Prepared<T>[] {
  return exportedDocs(value, field).map((src, index) => ({
    key: exportKey(src, index),
    sequence: sequenceNumber(src.number),
    input: prepare(src, `${field}[${index}]`),
  }));
}

@Injectable()
export class ProjectTransferService {
  constructor(
    private projectsService: ProjectsService,
    private todosService: TodosService,
    private sessionsService: SessionsService,
    private knowledgeService: KnowledgeService,
    private changelogService: ChangelogService,
    private milestonesService: MilestonesService,
    private environmentsService: EnvironmentsService,
    private secretsService: SecretsService,
    private manualsService: ManualsService,
    private researchService: ResearchService,
    private schemasService: SchemasService,
    private dependenciesService: DependenciesService,
    private featuresService: FeaturesService,
    private countersService: CountersService,
    @InjectModel(Secret.name) private secretModel: Model<SecretDocument>,
  ) {}

  async exportProject(projectId: string, includeSecretValues = false): Promise<ProjectExport> {
    const project = await this.projectsService.findById(projectId);

    const [
      todos, sessions, knowledge, changelog, milestones,
      environments, secrets, manuals, research, schemas,
      dependencies, features,
    ] = await Promise.all([
      this.todosService.findAll({ projectId, includeArchived: true }),
      this.sessionsService.findByProject(projectId, 999999),
      this.knowledgeService.findByProject(projectId),
      this.changelogService.findByProject(projectId, 999999),
      this.milestonesService.findByProject(projectId, undefined, true),
      this.environmentsService.findByProject(projectId),
      includeSecretValues
        ? this.secretModel.find({ projectId }).lean().exec()
        : this.secretsService.findByProject(projectId),
      this.manualsService.findByProject(projectId),
      this.researchService.findByProject(projectId),
      this.schemasService.findByProject(projectId),
      this.dependenciesService.findByProject(projectId),
      this.featuresService.findByProject(projectId),
    ]);

    // Fetch schema versions
    const schemasWithVersions = await Promise.all(
      schemas.map(async (s) => {
        const obj = toPlainDoc(s);
        // Die ID kommt vom typisierten Dokument, nicht aus dem PlainDoc: sonst
        // hinge die Versions-Abfrage an einer Laufzeit-Prüfung, und ein Fehlschlag
        // würde die Versionen still auf [] setzen statt laut zu scheitern.
        const versions = await this.schemasService.getVersions(s._id.toString());
        obj._versions = versions.map((v) => stripFields(toPlainDoc(v), ['__v']));
        return obj;
      }),
    );

    const strip = (items: unknown[]) =>
      items.map((item) => stripFields(toPlainDoc(item), ['__v', 'projectId']));

    const projectObj = stripFields(toPlainDoc(project), ['_id', '__v']);

    return {
      _exportVersion: 1,
      _exportedAt: new Date().toISOString(),
      _source: 'DevGrimoire',
      project: projectObj,
      todos: strip(todos),
      milestones: strip(milestones),
      changelog: strip(changelog),
      sessions: strip(sessions),
      knowledge: strip(knowledge),
      research: strip(research),
      environments: strip(environments),
      secrets: strip(secrets),
      manuals: strip(manuals),
      schemas: strip(schemasWithVersions),
      dependencies: strip(dependencies),
      features: strip(features),
    };
  }

  /**
   * `data` ist `unknown`, nicht `ProjectExport`: die Daten kommen aus
   * `JSON.parse` einer hochgeladenen Datei. Ein `ProjectExport`-Parameter hätte
   * eine Struktur behauptet, die niemand geprüft hat — und genau daran brach der
   * Import: ein fehlender Abschnitt lief in `for (… of undefined)`, HTTP 500,
   * Projekt bereits angelegt.
   */
  async importProject(
    data: unknown,
    nameOverride?: string,
  ): Promise<{ projectId: string; projectName: string; stats: Record<string, number> }> {
    const exp = asPlainDoc(data);
    if (!exp || exp._exportVersion !== 1 || exp._source !== 'DevGrimoire') {
      throw new BadRequestException('Invalid export format');
    }
    const projectSrc = asPlainDoc(exp.project);
    if (!projectSrc) {
      throw new BadRequestException('Invalid export format: project record is missing');
    }

    // -----------------------------------------------------------------------
    // Phase 1: alles lesen und prüfen — noch kein Schreibvorgang.
    // -----------------------------------------------------------------------
    const projectData: PlainDoc = { ...projectSrc };
    if (nameOverride) projectData.name = nameOverride;

    const baseName = asString(projectData.name);
    if (!baseName) {
      throw new BadRequestException('Invalid export format: project.name is missing');
    }

    delete projectData.createdAt;
    delete projectData.updatedAt;

    const environments = prepareSection(exp.environments, 'environments', prepareEnvironment);
    const secrets = prepareSection(exp.secrets, 'secrets', prepareSecret);
    const changelog = prepareSection(exp.changelog, 'changelog', prepareChangelog);
    const milestones = prepareSection(exp.milestones, 'milestones', prepareMilestone);
    const todos = prepareSection(exp.todos, 'todos', prepareTodo);
    const sessions = prepareSection(exp.sessions, 'sessions', prepareSession);
    const knowledge = prepareSection(exp.knowledge, 'knowledge', prepareKnowledge);
    const research = prepareSection(exp.research, 'research', prepareResearch);
    const manuals = prepareSection(exp.manuals, 'manuals', prepareManual);
    const schemas = prepareSection(exp.schemas, 'schemas', prepareSchema);
    const dependencies = prepareSection(exp.dependencies, 'dependencies', prepareDependency);
    const features = prepareSection(exp.features, 'features', prepareFeature);

    // Namenskollision auflösen statt scheitern — `Project.name` ist unique. Eine
    // einzelne `(Import)`-Variante reichte dafür nicht: beim dritten Import
    // derselben Datei war auch die belegt, und der Duplicate-Key-Fehler kam als
    // HTTP 500 zurück.
    let finalName = baseName;
    let suffix = 0;
    while (await this.projectsService.findByName(finalName)) {
      suffix += 1;
      finalName = suffix === 1 ? `${baseName} (Import)` : `${baseName} (Import ${suffix})`;
    }

    // -----------------------------------------------------------------------
    // Phase 2: schreiben.
    // -----------------------------------------------------------------------
    // Das Projekt wird *vollständig* durchgereicht, auch mit Feldern, die
    // `CreateProjectDto` nicht deklariert (components, replicationConfig,
    // instructions-Erweiterungen …). Der Spread genügt dafür: `name` ist
    // statisch als String belegt, alles Weitere reist über die Index-Signatur
    // mit, und welche Felder geschrieben werden, entscheidet das
    // Mongoose-Schema. Ein explizites Feld-Mapping würde genau diese Felder
    // verlieren.
    const project = await this.projectsService.create({ ...projectData, name: finalName });
    const projectId = project._id.toString();

    const stats: Record<string, number> = {};

    // Build ID maps for reference remapping
    const envIdMap = new Map<string, string>();
    const changelogIdMap = new Map<string, string>();
    const milestoneIdMap = new Map<string, string>();
    const todoIdMap = new Map<string, string>();

    // 1. Environments
    for (const env of environments) {
      const newEnv = await this.environmentsService.create({ ...env.input, projectId });
      envIdMap.set(env.key, newEnv._id.toString());
    }
    stats.environments = environments.length;

    // 2. Secrets (remap environmentId)
    let importedSecrets = 0;
    for (const sec of secrets) {
      const input = sec.input;
      // Metadaten-Export ohne Wert: nicht rekonstruierbar, wird übersprungen.
      if (!input) continue;
      // Zeigt die Referenz auf ein Environment, das nicht mitgekommen ist, wird
      // das Secret projekt-global — wie vorher.
      const envId = input.sourceEnvironmentId
        ? envIdMap.get(input.sourceEnvironmentId)
        : undefined;
      await this.secretModel.create({
        projectId,
        key: input.key,
        encryptedValue: input.encryptedValue,
        description: input.description,
        type: input.type,
        environmentId: envId ?? null,
      });
      importedSecrets += 1;
    }
    stats.secrets = importedSecrets;

    // 3. Changelog
    for (const cl of changelog) {
      const newCl = await this.changelogService.create({ ...cl.input, projectId });
      changelogIdMap.set(cl.key, newCl._id.toString());
    }
    stats.changelog = changelog.length;

    // 4. Milestones (remap changelogId)
    for (const ms of milestones) {
      const { rawStatus, status, archived, sourceChangelogId } = ms.input;
      const clId = sourceChangelogId ? changelogIdMap.get(sourceChangelogId) : undefined;
      const newMs = await this.milestonesService.create({ ...ms.input.dto, projectId });
      // Update status + changelogId + archived directly
      if (rawStatus && status !== MilestoneStatus.OPEN) {
        await this.milestonesService.update(newMs._id.toString(), {
          // `done` nur mit Changelog-Referenz — milestonesService.update lehnt es
          // sonst ab. Ohne clId bleibt der Milestone bewusst auf `open`.
          status:
            status === MilestoneStatus.DONE && clId
              ? MilestoneStatus.DONE
              : status === MilestoneStatus.IN_PROGRESS
                ? MilestoneStatus.IN_PROGRESS
                : undefined,
          changelogId: clId,
          archived,
        });
      } else if (archived) {
        await this.milestonesService.update(newMs._id.toString(), { archived: true });
      }
      milestoneIdMap.set(ms.key, newMs._id.toString());
    }
    stats.milestones = milestones.length;

    // 5. Todos (remap milestoneId, blockedBy)
    for (const todo of todos) {
      const sourceMsId = todo.input.sourceMilestoneId;
      const msId = sourceMsId ? milestoneIdMap.get(sourceMsId) : undefined;
      const newTodo = await this.todosService.create({
        ...todo.input.dto,
        projectId,
        milestoneId: msId,
      });
      todoIdMap.set(todo.key, newTodo._id.toString());
    }
    // Second pass: update blockedBy + status + comments + archived
    for (const todo of todos) {
      const newId = todoIdMap.get(todo.key);
      // Unerreichbar: der erste Durchlauf hat jeden Key gesetzt.
      if (!newId) continue;
      const updates: UpdateTodoDto = {};
      const blockedBy = todo.input.sourceBlockedBy;
      if (blockedBy && blockedBy.length > 0) {
        // Unbekannte IDs gehen unverändert weiter: Mongoose lehnt sie beim
        // ObjectId-Cast lautstark ab, wie vorher auch.
        updates.blockedBy = blockedBy.map((oldTodoId) => todoIdMap.get(oldTodoId) ?? oldTodoId);
      }
      if (todo.input.archived) updates.archived = true;
      if (Object.keys(updates).length > 0) {
        await this.todosService.update(newId, updates);
      }
      // Advance status step by step
      const targetIdx = TODO_STATUS_ORDER.findIndex((s) => s === todo.input.rawStatus);
      for (let i = 1; i <= targetIdx; i++) {
        try {
          await this.todosService.update(newId, { status: TODO_STATUS_ORDER[i] });
        } catch {
          break;
        }
      }
      // Import comments
      for (const comment of todo.input.comments) {
        await this.todosService.addComment(newId, comment.text, comment.author);
      }
    }
    stats.todos = todos.length;

    // 6. Sessions
    for (const s of sessions) {
      await this.sessionsService.create({ ...s.input, projectId });
    }
    stats.sessions = sessions.length;

    // 7. Knowledge
    for (const k of knowledge) {
      await this.knowledgeService.create({ ...k.input, projectId });
    }
    stats.knowledge = knowledge.length;

    // 8. Research
    for (const r of research) {
      await this.researchService.create({ ...r.input, projectId });
    }
    stats.research = research.length;

    // 9. Manuals
    for (const m of manuals) {
      await this.manualsService.create({ ...m.input, projectId });
    }
    stats.manuals = manuals.length;

    // 10. Schemas
    for (const s of schemas) {
      await this.schemasService.create({ ...s.input, projectId });
      // Versions are snapshots — we skip re-importing them as the schema is already at latest state
    }
    stats.schemas = schemas.length;

    // 11. Dependencies
    for (const d of dependencies) {
      await this.dependenciesService.create({ ...d.input, projectId });
    }
    stats.dependencies = dependencies.length;

    // 12. Features
    for (const f of features) {
      await this.featuresService.create({ ...f.input, projectId });
    }
    stats.features = features.length;

    // Set counter sequences to max number found
    const maxTodoNum = todos.reduce((max, t) => Math.max(max, t.sequence), 0);
    const maxMsNum = milestones.reduce((max, m) => Math.max(max, m.sequence), 0);
    if (maxTodoNum > 0) await this.countersService.setSequence(projectId, 'todo', maxTodoNum);
    if (maxMsNum > 0) await this.countersService.setSequence(projectId, 'milestone', maxMsNum);

    return { projectId, projectName: project.name, stats };
  }
}
