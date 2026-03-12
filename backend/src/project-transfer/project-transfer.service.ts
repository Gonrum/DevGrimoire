import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
import { ProjectExport } from './project-export.interface';

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
        const obj = this.toPlain(s);
        const versions = await this.schemasService.getVersions(obj._id as string);
        obj._versions = versions.map((v) => this.stripFields(this.toPlain(v), ['__v']));
        return obj;
      }),
    );

    const strip = (items: any[]) =>
      items.map((item) => this.stripFields(this.toPlain(item), ['__v', 'projectId']));

    const projectObj = this.stripFields(this.toPlain(project), ['_id', '__v']);

    return {
      _exportVersion: 1,
      _exportedAt: new Date().toISOString(),
      _source: 'ClaudeVault',
      project: projectObj,
      todos: strip(todos),
      milestones: strip(milestones),
      changelog: strip(changelog),
      sessions: strip(sessions),
      knowledge: strip(knowledge),
      research: strip(research),
      environments: strip(environments),
      secrets: strip(includeSecretValues ? secrets : secrets),
      manuals: strip(manuals),
      schemas: strip(schemasWithVersions) as ProjectExport['schemas'],
      dependencies: strip(dependencies),
      features: strip(features),
    };
  }

  async importProject(
    data: ProjectExport,
    nameOverride?: string,
  ): Promise<{ projectId: string; projectName: string; stats: Record<string, number> }> {
    if (data._exportVersion !== 1 || data._source !== 'ClaudeVault') {
      throw new BadRequestException('Invalid export format');
    }

    // Create project
    const projectData = { ...data.project } as any;
    if (nameOverride) projectData.name = nameOverride;

    // Check if name already exists
    const existing = await this.projectsService.findByName(projectData.name);
    if (existing) {
      projectData.name = `${projectData.name} (Import)`;
    }

    delete projectData.createdAt;
    delete projectData.updatedAt;
    const project = await this.projectsService.create(projectData);
    const projectId = project._id.toString();

    const stats: Record<string, number> = {};

    // Build ID maps for reference remapping
    const envIdMap = new Map<string, string>();
    const changelogIdMap = new Map<string, string>();
    const milestoneIdMap = new Map<string, string>();
    const todoIdMap = new Map<string, string>();
    const schemaIdMap = new Map<string, string>();

    // 1. Environments
    for (const env of data.environments) {
      const oldId = env._id as string;
      const newEnv = await this.environmentsService.create({
        projectId,
        name: env.name as string,
        variables: env.variables as any,
        active: env.active as boolean ?? true,
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
    for (const cl of data.changelog) {
      const oldId = cl._id as string;
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
    for (const ms of data.milestones) {
      const oldId = ms._id as string;
      const clId = ms.changelogId ? changelogIdMap.get(ms.changelogId as string) : undefined;
      const newMs = await this.milestonesService.create({
        projectId,
        name: ms.name as string,
        description: ms.description as string,
        dueDate: ms.dueDate as string,
      });
      // Update status + changelogId + archived directly
      if (ms.status && ms.status !== 'open') {
        await this.milestonesService.update(newMs._id.toString(), {
          status: ms.status === 'done' && clId ? 'done' : ms.status === 'in_progress' ? 'in_progress' : undefined,
          changelogId: clId,
          archived: ms.archived as boolean,
        } as any);
      } else if (ms.archived) {
        await this.milestonesService.update(newMs._id.toString(), { archived: true } as any);
      }
      milestoneIdMap.set(oldId, newMs._id.toString());
    }
    stats.milestones = data.milestones.length;

    // 5. Todos (remap milestoneId, blockedBy)
    for (const todo of data.todos) {
      const oldId = todo._id as string;
      const msId = todo.milestoneId ? milestoneIdMap.get(todo.milestoneId as string) : undefined;
      const newTodo = await this.todosService.create({
        projectId,
        title: todo.title as string,
        description: todo.description as string,
        priority: todo.priority as any,
        tags: todo.tags as string[],
        milestoneId: msId,
      });
      todoIdMap.set(oldId, newTodo._id.toString());
    }
    // Second pass: update blockedBy + status + comments + archived
    for (const todo of data.todos) {
      const newId = todoIdMap.get(todo._id as string)!;
      const updates: any = {};
      if (todo.blockedBy && (todo.blockedBy as string[]).length > 0) {
        updates.blockedBy = (todo.blockedBy as string[]).map((id) => todoIdMap.get(id) || id);
      }
      if (todo.archived) updates.archived = true;
      if (Object.keys(updates).length > 0) {
        await this.todosService.update(newId, updates);
      }
      // Advance status step by step
      const statuses = ['open', 'in_progress', 'review', 'done'];
      const targetIdx = statuses.indexOf(todo.status as string);
      for (let i = 1; i <= targetIdx; i++) {
        try {
          await this.todosService.update(newId, { status: statuses[i] as any });
        } catch {
          break;
        }
      }
      // Import comments
      if (todo.comments && Array.isArray(todo.comments)) {
        for (const comment of todo.comments as any[]) {
          await this.todosService.addComment(newId, comment.text, comment.author || 'import');
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
    for (const s of data.schemas) {
      const oldId = s._id as string;
      const newSchema = await this.schemasService.create({
        projectId,
        name: s.name as string,
        dbType: s.dbType as any,
        database: s.database as string,
        description: s.description as string,
        fields: s.fields as any,
        indexes: s.indexes as any,
        tags: s.tags as string[],
      });
      schemaIdMap.set(oldId, newSchema._id.toString());
      // Versions are snapshots — we skip re-importing them as the schema is already at latest state
    }
    stats.schemas = data.schemas.length;

    // 11. Dependencies
    for (const d of data.dependencies) {
      await this.dependenciesService.create({
        projectId,
        name: d.name as string,
        version: d.version as string,
        packageManager: d.packageManager as any,
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
        status: f.status as any,
        version: f.version as string,
        priority: f.priority as any,
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

  private toPlain(doc: any): Record<string, unknown> {
    if (doc && typeof doc.toObject === 'function') return doc.toObject();
    return { ...doc };
  }

  private stripFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
    const result = { ...obj };
    for (const f of fields) delete result[f];
    // Convert ObjectId to string
    if (result._id) result._id = result._id.toString();
    return result;
  }
}
