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
import { CreateProjectDto } from '../projects/dto/create-project.dto';
import { UpdateTodoDto } from '../todos/dto/update-todo.dto';
import { TodoStatus, TodoPriority } from '../todos/schemas/todo.schema';
import { MilestoneStatus } from '../milestones/schemas/milestone.schema';
import { DbType } from '../schemas/schemas/db-schema.schema';
import { PackageManager } from '../dependencies/schemas/dependency.schema';
import { FeatureStatus, FeaturePriority } from '../features/schemas/feature.schema';
import { ProjectExport } from './project-export.interface';

/**
 * Ein exportiertes bzw. zu importierendes Dokument. Export/Import laufen quer
 * über ~13 Collections; ein konkreter Typ, der auf alle passt, wäre eine
 * Erfindung. `PlainDoc` sagt genau das aus, was hier stimmt: Objekt mit
 * String-Keys, Werte erst an der Zugriffsstelle verengt.
 */
type PlainDoc = Record<string, unknown>;

/**
 * Normalisiert Mongoose-Dokumente und Plain Objects (lean(), JSON.parse) auf
 * dieselbe Form. Bewusst `toObject` per Duck-Typing statt `toJSON` — `toJSON`
 * würde Schema-Transforms anwenden und damit den Export-Inhalt verändern.
 *
 * Die beiden Assertions bleiben auf diesen Helfer beschränkt; genau dieses
 * Muster steht in `src/mcp-tools.ts` (dort mit `toJSON`) und hat drei
 * `doc: any`-Helfer über 86 Aufrufstellen ersetzt.
 */
function toPlainDoc(doc: unknown): PlainDoc {
  if (doc === null || typeof doc !== 'object') return {};
  const toObject = (doc as { toObject?: unknown }).toObject;
  if (typeof toObject === 'function') {
    const plain: unknown = (toObject as () => unknown).call(doc);
    if (plain !== null && typeof plain === 'object') return { ...(plain as PlainDoc) };
  }
  return { ...(doc as PlainDoc) };
}

/** Liest ein Feld eines PlainDoc als String — oder undefined, wenn es keiner ist. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `Array.isArray()` verengt `unknown` zu `any[]` und schleppt damit `any` in
 * jede Schleife darüber. Das Prädikat verengt zu `unknown[]`.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
  return asString(doc._id) ?? `#${index}`;
}

/**
 * Verengt einen exportierten Wert auf einen Enum-Wert — ohne Cast, weil
 * `Object.values(Enum).find(...)` schon den Enum-Typ liefert. Unbekannte Werte
 * ergeben `undefined`, ohne zu werfen.
 */
function matchEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
  const raw = asString(value);
  return raw === undefined ? undefined : values.find((candidate) => candidate === raw);
}

/**
 * Wie `matchEnum`, aber laut: Fehlender Wert → `undefined`, damit der
 * Schema-Default greift (wie vorher). Vorhandener, aber unbekannter Wert →
 * Fehler, damit er nicht still auf den Default zurückfällt; vorher lief er in
 * die Mongoose-Enum-Validierung und brach den Import ebenfalls ab.
 */
function asEnum<T extends string>(values: readonly T[], value: unknown, field: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  const match = matchEnum(values, value);
  if (match === undefined) {
    throw new BadRequestException(`Invalid value for "${field}" in export: ${JSON.stringify(value)}`);
  }
  return match;
}

/**
 * Reicht ein exportiertes Array verschachtelter Objekte **unverändert** an einen
 * Service weiter.
 *
 * Hier sitzt eine unvermeidbare Behauptung, und zwar genau eine für alle drei
 * Aufrufstellen (env.variables, schema.fields, schema.indexes): Der Export
 * enthält die Felder so, wie das Mongoose-Schema sie geschrieben hat — das ist
 * mehr, als die DTO-Klasse deklariert (und `EnvVariableDto` ist nicht einmal
 * exportiert). Ein explizites Feld-Mapping würde beim Import genau die Felder
 * verlieren, die das DTO nicht kennt. Zur Laufzeit wird geprüft, dass es
 * überhaupt ein Array ist; die Feldvalidierung macht Mongoose beim Schreiben.
 *
 * Nicht-Objekte werden absichtlich NICHT herausgefiltert: Mongoose lehnt sie
 * lautstark ab, still verwerfen würde Nutzerdaten verlieren.
 */
function asNestedArray<T>(value: unknown, field: string): T[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isUnknownArray(value)) {
    throw new BadRequestException(`Field "${field}" must be an array`);
  }
  return value as T[];
}

/** Kopie ohne die genannten Felder, `_id` als String. */
function stripFields(obj: PlainDoc, fields: string[]): PlainDoc {
  const result = { ...obj };
  for (const f of fields) delete result[f];
  // Convert ObjectId to string
  const id = idAsString(result._id);
  if (id !== undefined) result._id = id;
  return result;
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

  async importProject(
    data: ProjectExport,
    nameOverride?: string,
  ): Promise<{ projectId: string; projectName: string; stats: Record<string, number> }> {
    if (data._exportVersion !== 1 || data._source !== 'DevGrimoire') {
      throw new BadRequestException('Invalid export format');
    }

    // Create project
    const projectData: PlainDoc = { ...data.project };
    if (nameOverride) projectData.name = nameOverride;

    const baseName = asString(projectData.name);
    if (!baseName) {
      throw new BadRequestException('Invalid export format: project.name is missing');
    }
    projectData.name = baseName;

    // Check if name already exists
    const existing = await this.projectsService.findByName(baseName);
    if (existing) {
      projectData.name = `${baseName} (Import)`;
    }

    delete projectData.createdAt;
    delete projectData.updatedAt;
    // Behauptung an der Service-Grenze: Das Projekt wird *vollständig*
    // durchgereicht, auch mit Feldern, die CreateProjectDto nicht deklariert
    // (components, replicationConfig, instructions-Erweiterungen …). Ein
    // explizites Mapping würde beim Import genau diese Felder verlieren; welche
    // davon geschrieben werden, entscheidet das Mongoose-Schema. `name` ist die
    // einzige Pflicht-Property des DTO und direkt darüber als String geprüft.
    const project = await this.projectsService.create(projectData as unknown as CreateProjectDto);
    const projectId = project._id.toString();

    const stats: Record<string, number> = {};

    // Build ID maps for reference remapping
    const envIdMap = new Map<string, string>();
    const changelogIdMap = new Map<string, string>();
    const milestoneIdMap = new Map<string, string>();
    const todoIdMap = new Map<string, string>();
    const schemaIdMap = new Map<string, string>();

    // 1. Environments
    for (const [index, env] of data.environments.entries()) {
      const oldId = exportKey(env, index);
      const newEnv = await this.environmentsService.create({
        projectId,
        name: env.name as string,
        variables: asNestedArray(env.variables, 'environments[].variables'),
        active: typeof env.active === 'boolean' ? env.active : true,
      });
      envIdMap.set(oldId, newEnv._id.toString());
    }
    stats.environments = data.environments.length;

    // 2. Secrets (remap environmentId)
    for (const sec of data.secrets) {
      const envId = sec.environmentId ? envIdMap.get(sec.environmentId as string) || undefined : undefined;
      if (sec.encryptedValue) {
        // Raw secret with encrypted value — insert directly
        await this.secretModel.create({
          projectId,
          key: sec.key,
          encryptedValue: sec.encryptedValue,
          description: sec.description,
          type: sec.type || 'variable',
          environmentId: envId || null,
        });
      } else {
        // Metadata-only export — create placeholder
        // Skip: we can't recreate secrets without values
      }
    }
    stats.secrets = data.secrets.filter((s) => s.encryptedValue).length;

    // 3. Changelog
    for (const [index, cl] of data.changelog.entries()) {
      const oldId = exportKey(cl, index);
      const newCl = await this.changelogService.create({
        projectId,
        version: cl.version as string,
        changes: cl.changes as string[],
        summary: cl.summary as string,
        component: cl.component as string,
      });
      changelogIdMap.set(oldId, newCl._id.toString());
    }
    stats.changelog = data.changelog.length;

    // 4. Milestones (remap changelogId)
    for (const [index, ms] of data.milestones.entries()) {
      const oldId = exportKey(ms, index);
      const clId = ms.changelogId ? changelogIdMap.get(ms.changelogId as string) : undefined;
      const newMs = await this.milestonesService.create({
        projectId,
        name: ms.name as string,
        description: ms.description as string,
        dueDate: ms.dueDate as string,
      });
      // Update status + changelogId + archived directly
      // Unbekannte Status-Werte laufen wie vorher in den Zweig ohne
      // Status-Änderung (nur changelogId/archived), statt den Import abzubrechen.
      const rawStatus = asString(ms.status);
      const oldStatus = matchEnum(MILESTONE_STATUSES, rawStatus);
      if (rawStatus && oldStatus !== MilestoneStatus.OPEN) {
        await this.milestonesService.update(newMs._id.toString(), {
          // `done` nur mit Changelog-Referenz — milestonesService.update lehnt es
          // sonst ab. Ohne clId bleibt der Milestone bewusst auf `open`.
          status:
            oldStatus === MilestoneStatus.DONE && clId
              ? MilestoneStatus.DONE
              : oldStatus === MilestoneStatus.IN_PROGRESS
                ? MilestoneStatus.IN_PROGRESS
                : undefined,
          changelogId: clId,
          archived: ms.archived as boolean,
        });
      } else if (ms.archived) {
        await this.milestonesService.update(newMs._id.toString(), { archived: true });
      }
      milestoneIdMap.set(oldId, newMs._id.toString());
    }
    stats.milestones = data.milestones.length;

    // 5. Todos (remap milestoneId, blockedBy)
    for (const [index, todo] of data.todos.entries()) {
      const oldId = exportKey(todo, index);
      const msId = todo.milestoneId ? milestoneIdMap.get(todo.milestoneId as string) : undefined;
      const newTodo = await this.todosService.create({
        projectId,
        title: todo.title as string,
        description: todo.description as string,
        priority: asEnum(TODO_PRIORITIES, todo.priority, 'todos[].priority'),
        tags: todo.tags as string[],
        milestoneId: msId,
      });
      todoIdMap.set(oldId, newTodo._id.toString());
    }
    // Second pass: update blockedBy + status + comments + archived
    for (const [index, todo] of data.todos.entries()) {
      const newId = todoIdMap.get(exportKey(todo, index));
      // Unerreichbar: der erste Durchlauf hat jeden Key gesetzt.
      if (!newId) continue;
      const updates: UpdateTodoDto = {};
      if (isUnknownArray(todo.blockedBy) && todo.blockedBy.length > 0) {
        // Nicht-String-Einträge gehen als '' weiter statt verworfen zu werden:
        // Mongoose lehnt sie beim ObjectId-Cast lautstark ab, wie vorher auch.
        updates.blockedBy = todo.blockedBy.map((entry) => {
          const oldTodoId = asString(entry) ?? '';
          return todoIdMap.get(oldTodoId) ?? oldTodoId;
        });
      }
      if (todo.archived) updates.archived = true;
      if (Object.keys(updates).length > 0) {
        await this.todosService.update(newId, updates);
      }
      // Advance status step by step
      const targetStatus = asString(todo.status);
      const targetIdx = TODO_STATUS_ORDER.findIndex((s) => s === targetStatus);
      for (let i = 1; i <= targetIdx; i++) {
        try {
          await this.todosService.update(newId, { status: TODO_STATUS_ORDER[i] });
        } catch {
          break;
        }
      }
      // Import comments
      if (isUnknownArray(todo.comments)) {
        for (const comment of todo.comments) {
          const c = toPlainDoc(comment);
          await this.todosService.addComment(newId, asString(c.text) ?? '', asString(c.author) || 'import');
        }
      }
    }
    stats.todos = data.todos.length;

    // 6. Sessions
    for (const s of data.sessions) {
      await this.sessionsService.create({
        projectId,
        summary: s.summary as string,
        filesChanged: s.filesChanged as string[],
        nextSteps: s.nextSteps as string[],
        openQuestions: s.openQuestions as string[],
      });
    }
    stats.sessions = data.sessions.length;

    // 7. Knowledge
    for (const k of data.knowledge) {
      await this.knowledgeService.create({
        projectId,
        topic: k.topic as string,
        content: k.content as string,
        tags: k.tags as string[],
        category: k.category as string,
      });
    }
    stats.knowledge = data.knowledge.length;

    // 8. Research
    for (const r of data.research) {
      await this.researchService.create({
        projectId,
        title: r.title as string,
        content: r.content as string,
        sources: r.sources as string[],
        tags: r.tags as string[],
      });
    }
    stats.research = data.research.length;

    // 9. Manuals
    for (const m of data.manuals) {
      await this.manualsService.create({
        projectId,
        title: m.title as string,
        content: m.content as string,
        category: m.category as string,
        sortOrder: m.sortOrder as number,
      });
    }
    stats.manuals = data.manuals.length;

    // 10. Schemas + Versions
    for (const [index, s] of data.schemas.entries()) {
      const oldId = exportKey(s, index);
      const dbType = asEnum(DB_TYPES, s.dbType, 'schemas[].dbType');
      if (!dbType) {
        throw new BadRequestException(
          `Invalid export format: schema "${asString(s.name) ?? '?'}" has no dbType`,
        );
      }
      const newSchema = await this.schemasService.create({
        projectId,
        name: s.name as string,
        dbType,
        database: s.database as string,
        description: s.description as string,
        fields: asNestedArray(s.fields, 'schemas[].fields'),
        indexes: asNestedArray(s.indexes, 'schemas[].indexes'),
        tags: s.tags as string[],
      });
      schemaIdMap.set(oldId, newSchema._id.toString());
      // Versions are snapshots — we skip re-importing them as the schema is already at latest state
    }
    stats.schemas = data.schemas.length;

    // 11. Dependencies
    for (const d of data.dependencies) {
      const packageManager = asEnum(PACKAGE_MANAGERS, d.packageManager, 'dependencies[].packageManager');
      if (!packageManager) {
        throw new BadRequestException(
          `Invalid export format: dependency "${asString(d.name) ?? '?'}" has no packageManager`,
        );
      }
      await this.dependenciesService.create({
        projectId,
        name: d.name as string,
        version: d.version as string,
        packageManager,
        description: d.description as string,
        devDependency: d.devDependency as boolean,
        category: d.category as string,
        tags: d.tags as string[],
      });
    }
    stats.dependencies = data.dependencies.length;

    // 12. Features
    for (const f of data.features) {
      await this.featuresService.create({
        projectId,
        name: f.name as string,
        description: f.description as string,
        category: f.category as string,
        status: asEnum(FEATURE_STATUSES, f.status, 'features[].status'),
        version: f.version as string,
        priority: asEnum(FEATURE_PRIORITIES, f.priority, 'features[].priority'),
        tags: f.tags as string[],
      });
    }
    stats.features = data.features.length;

    // Set counter sequences to max number found
    const maxTodoNum = data.todos.reduce((max, t) => Math.max(max, (t.number as number) || 0), 0);
    const maxMsNum = data.milestones.reduce((max, m) => Math.max(max, (m.number as number) || 0), 0);
    if (maxTodoNum > 0) await this.countersService.setSequence(projectId, 'todo', maxTodoNum);
    if (maxMsNum > 0) await this.countersService.setSequence(projectId, 'milestone', maxMsNum);

    return { projectId, projectName: project.name, stats };
  }
}
