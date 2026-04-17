import { Injectable, Logger } from '@nestjs/common';
import { TodosService } from '../todos/todos.service';
import { MilestonesService } from '../milestones/milestones.service';
import { ChangelogService } from '../changelog/changelog.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ResearchService } from '../research/research.service';
import { ManualsService } from '../manuals/manuals.service';
import { SessionsService } from '../sessions/sessions.service';
import { SchemasService } from '../schemas/schemas.service';
import { DependenciesService } from '../dependencies/dependencies.service';
import { FeaturesService } from '../features/features.service';
import { RagService } from '../rag/rag.service';
import { LogsService } from '../logs/logs.service';
import { WebSearchService } from '../web-search/services/web-search.service';
import { ReadabilityService } from '../web-search/services/readability.service';
import { SearchCategory, SearchTimeRange } from '../web-search/dto/web-search.dto';

/**
 * Tools split by read/write so the Settings UI can surface write tools with a
 * distinct warning. Write tools let the chat LLM mutate DevGrimoire data —
 * keep them opt-in by default (see DEFAULT_TOOLS_ALLOWLIST in chat-llm.service.ts).
 */
export const TOOL_GROUPS: Record<
  'tasks_read' | 'tasks_write' | 'knowledge_read' | 'knowledge_write' | 'project_read' | 'project_write' | 'external_read',
  string[]
> = {
  tasks_read: ['todo_list', 'todo_get', 'milestone_list', 'milestone_get', 'changelog_list', 'changelog_get'],
  tasks_write: [
    'todo_create',
    'todo_update',
    'todo_comment',
    'milestone_create',
    'milestone_update',
    'changelog_add',
  ],
  knowledge_read: [
    'rag_search',
    'knowledge_search',
    'knowledge_get',
    'research_search',
    'research_get',
    'manual_list',
    'manual_get',
  ],
  knowledge_write: ['knowledge_save', 'knowledge_update', 'research_save', 'manual_create', 'manual_update'],
  project_read: ['session_get', 'schema_list', 'schema_get', 'dependency_list', 'feature_list'],
  project_write: ['session_save', 'feature_create', 'feature_update', 'dependency_add'],
  external_read: ['web_search', 'web_fetch'],
};

export const ALL_TOOL_NAMES: string[] = Object.values(TOOL_GROUPS).flat();

/** Tools that mutate state — used by the UI to apply warning styling + confirmation. */
export const WRITE_TOOL_NAMES: Set<string> = new Set([
  ...TOOL_GROUPS.tasks_write,
  ...TOOL_GROUPS.knowledge_write,
  ...TOOL_GROUPS.project_write,
]);

/**
 * Tools that are hardcoded OFF regardless of what's in the allowlist. Destructive
 * bulk operations should never be LLM-driven.
 */
export const PERMANENTLY_BLOCKED_TOOLS: Set<string> = new Set([
  'project_delete',
  'project_update',
  'todo_delete',
  'milestone_delete',
  'knowledge_delete',
  'changelog_delete',
  'research_delete',
  'manual_delete',
  'schema_delete',
  'dependency_delete',
  'feature_delete',
  'release_delete',
  'snippet_delete',
  'secret_delete',
  'environment_delete',
  'attachment_delete',
]);

/** Minimal JSON-Schema fragment for OpenAI function parameters */
type JsonSchemaProp = {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string; enum?: string[] };
};

type JsonSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** OpenAI-compatible function wrapper */
export interface OpenAiTool {
  type: 'function';
  function: ToolDefinition;
}

const PROJECT_ID_PROP = {
  type: 'string',
  description: 'MongoDB ID des Projekts. Wenn nicht angegeben wird der aktuelle Chat-Projekt-Kontext verwendet.',
};

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  todo_list: {
    name: 'todo_list',
    description: 'Listet Todos eines Projekts. Unterstützt Filter nach Status, Priorität, Milestone, Tag.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'], description: 'Filter nach Status' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        milestoneId: { type: 'string' },
        tag: { type: 'string' },
        includeArchived: { type: 'boolean' },
        limit: { type: 'number', description: 'Max. Anzahl (Default 50)' },
      },
    },
  },
  todo_get: {
    name: 'todo_get',
    description: 'Lädt vollständigen Todo mit Beschreibung und Kommentaren.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Todo MongoDB ID' } },
      required: ['id'],
    },
  },
  milestone_list: {
    name: 'milestone_list',
    description: 'Listet Milestones eines Projekts.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        includeArchived: { type: 'boolean' },
      },
    },
  },
  milestone_get: {
    name: 'milestone_get',
    description: 'Lädt Milestone-Details.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  changelog_list: {
    name: 'changelog_list',
    description: 'Listet Changelog-Einträge eines Projekts (neueste zuerst).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        limit: { type: 'number', description: 'Default 20' },
      },
    },
  },
  changelog_get: {
    name: 'changelog_get',
    description: 'Lädt vollständigen Changelog-Eintrag.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  rag_search: {
    name: 'rag_search',
    description: 'Semantische Suche über alle indizierten Einträge (Knowledge, Research, Manual, Changelog, Todo, Session, Snippet, Attachment).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
        projectId: PROJECT_ID_PROP,
        entity: { type: 'string', enum: ['knowledge', 'research', 'manual', 'changelog', 'todo', 'session', 'snippet', 'attachment'] },
        limit: { type: 'number', description: 'Default 10' },
      },
      required: ['query'],
    },
  },
  web_search: {
    name: 'web_search',
    description: 'Sucht im öffentlichen Web via SearXNG. Nur lesend + gecacht. Für Projekt-Wissen lieber rag_search verwenden.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
        language: { type: 'string', description: 'ISO 639-1 Code (z.B. "de", "en")' },
        categories: { type: 'array', items: { type: 'string', enum: ['general', 'news', 'science', 'it', 'files'] }, description: 'SearXNG-Kategorien' },
        timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Zeitfenster für die Treffer' },
        limit: { type: 'number', description: 'Max. Treffer (1–20, Default 10)' },
      },
      required: ['query'],
    },
  },
  web_fetch: {
    name: 'web_fetch',
    description: 'Lädt eine URL und extrahiert den Artikeltext via Readability. SSRF-geschützt (blockiert interne IPs). Mit raw=true plain text ohne Readability. Binärdateien (PDF, Bilder) werden abgelehnt.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Öffentliche http(s)-URL' },
        raw: { type: 'boolean', description: 'Readability überspringen und roh zurückgeben' },
        maxLength: { type: 'number', description: 'Text auf N Zeichen kürzen (Default 50000, Max 200000)' },
      },
      required: ['url'],
    },
  },
  knowledge_search: {
    name: 'knowledge_search',
    description: 'Keyword-basierte Suche in Wissenseinträgen (MongoDB Text-Index).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        projectId: PROJECT_ID_PROP,
        scope: { type: 'string', enum: ['global', 'project'] },
      },
      required: ['query'],
    },
  },
  knowledge_get: {
    name: 'knowledge_get',
    description: 'Lädt vollständigen Wissenseintrag.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  research_search: {
    name: 'research_search',
    description: 'Keyword-basierte Suche in Recherche-Einträgen.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        projectId: PROJECT_ID_PROP,
      },
      required: ['query'],
    },
  },
  research_get: {
    name: 'research_get',
    description: 'Lädt vollständigen Recherche-Eintrag.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  manual_list: {
    name: 'manual_list',
    description: 'Listet Handbuch-Einträge eines Projekts.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        category: { type: 'string' },
      },
    },
  },
  manual_get: {
    name: 'manual_get',
    description: 'Lädt vollständigen Handbuch-Eintrag.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  session_get: {
    name: 'session_get',
    description: 'Lädt letzte Arbeitssitzungen eines Projekts (neueste zuerst).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        limit: { type: 'number', description: 'Default 3' },
      },
    },
  },
  schema_list: {
    name: 'schema_list',
    description: 'Listet Datenbank-Schemas eines Projekts.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        dbType: { type: 'string', enum: ['mssql', 'mysql', 'mongodb', 'postgresql'] },
      },
    },
  },
  schema_get: {
    name: 'schema_get',
    description: 'Lädt vollständiges Schema inkl. Felder und Indexes.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  dependency_list: {
    name: 'dependency_list',
    description: 'Listet Paketabhängigkeiten eines Projekts.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        packageManager: { type: 'string', enum: ['npm', 'composer', 'pip', 'cargo', 'go', 'maven', 'nuget', 'gem'] },
        category: { type: 'string' },
      },
    },
  },
  feature_list: {
    name: 'feature_list',
    description: 'Listet Features eines Projekts.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        status: { type: 'string', enum: ['planned', 'in_development', 'released', 'deprecated'] },
        category: { type: 'string' },
      },
    },
  },

  // -------------------- WRITE TOOLS --------------------

  todo_create: {
    name: 'todo_create',
    description: 'Legt einen neuen Todo an.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        milestoneId: { type: 'string' },
      },
      required: ['title'],
    },
  },
  todo_update: {
    name: 'todo_update',
    description: 'Aktualisiert einen bestehenden Todo. Status-Transitionen müssen der Reihenfolge open → in_progress → review → done folgen (jeweils 1 Schritt).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        milestoneId: { type: 'string' },
        archived: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  todo_comment: {
    name: 'todo_comment',
    description: 'Fügt einem Todo einen Kommentar hinzu (für Fortschritts-Notizen, Review-Ergebnisse).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        author: { type: 'string', description: 'Default "claude"' },
      },
      required: ['id', 'text'],
    },
  },
  milestone_create: {
    name: 'milestone_create',
    description: 'Legt einen neuen Milestone an.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        name: { type: 'string' },
        description: { type: 'string' },
        dueDate: { type: 'string', description: 'ISO 8601' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
      },
      required: ['name'],
    },
  },
  milestone_update: {
    name: 'milestone_update',
    description: 'Aktualisiert einen Milestone. Für status=done ist eine changelogId zwingend erforderlich.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        dueDate: { type: 'string' },
        archived: { type: 'boolean' },
        changelogId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  changelog_add: {
    name: 'changelog_add',
    description: 'Erstellt einen neuen Changelog-Eintrag.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        changes: { type: 'array', items: { type: 'string' }, description: 'Liste der Änderungen als Strings (z.B. "feat: ...", "fix: ...")' },
        version: { type: 'string' },
        summary: { type: 'string' },
        component: { type: 'string' },
      },
      required: ['changes'],
    },
  },
  knowledge_save: {
    name: 'knowledge_save',
    description: 'Legt einen neuen Wissenseintrag an.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        topic: { type: 'string' },
        content: { type: 'string', description: 'Markdown unterstützt' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'project'] },
      },
      required: ['topic', 'content'],
    },
  },
  knowledge_update: {
    name: 'knowledge_update',
    description: 'Aktualisiert einen Wissenseintrag.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        topic: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string' },
      },
      required: ['id'],
    },
  },
  research_save: {
    name: 'research_save',
    description: 'Speichert eine Recherche mit Quellen.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        title: { type: 'string' },
        content: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content'],
    },
  },
  manual_create: {
    name: 'manual_create',
    description: 'Legt einen neuen Handbuch-Eintrag an.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        title: { type: 'string' },
        content: { type: 'string' },
        category: { type: 'string' },
        sortOrder: { type: 'number' },
      },
      required: ['title'],
    },
  },
  manual_update: {
    name: 'manual_update',
    description: 'Aktualisiert einen Handbuch-Eintrag.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        category: { type: 'string' },
        sortOrder: { type: 'number' },
      },
      required: ['id'],
    },
  },
  session_save: {
    name: 'session_save',
    description: 'Speichert eine Session-Zusammenfassung mit geänderten Dateien und nächsten Schritten.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        summary: { type: 'string' },
        filesChanged: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
        openQuestions: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
    },
  },
  feature_create: {
    name: 'feature_create',
    description: 'Legt ein neues Feature im Feature-Katalog an.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        name: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'in_development', 'released', 'deprecated'] },
        version: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  feature_update: {
    name: 'feature_update',
    description: 'Aktualisiert ein Feature.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'in_development', 'released', 'deprecated'] },
        version: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  dependency_add: {
    name: 'dependency_add',
    description: 'Legt eine einzelne Abhängigkeit an.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        name: { type: 'string' },
        version: { type: 'string' },
        packageManager: { type: 'string', enum: ['npm', 'composer', 'pip', 'cargo', 'go', 'maven', 'nuget', 'gem'] },
        description: { type: 'string' },
        devDependency: { type: 'boolean' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'version', 'packageManager'],
    },
  },
};

export interface ToolContext {
  projectId: string | null;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

@Injectable()
export class ChatToolsService {
  private readonly logger = new Logger(ChatToolsService.name);

  constructor(
    private readonly todos: TodosService,
    private readonly milestones: MilestonesService,
    private readonly changelog: ChangelogService,
    private readonly knowledge: KnowledgeService,
    private readonly research: ResearchService,
    private readonly manuals: ManualsService,
    private readonly sessions: SessionsService,
    private readonly schemas: SchemasService,
    private readonly dependencies: DependenciesService,
    private readonly features: FeaturesService,
    private readonly rag: RagService,
    private readonly logs: LogsService,
    private readonly webSearch: WebSearchService,
    private readonly readability: ReadabilityService,
  ) {}

  /** Fire-and-forget audit log for a write-tool call. Never throws. */
  private async auditWrite(
    name: string,
    projectId: string | undefined,
    args: Record<string, unknown>,
    result: ToolExecutionResult,
  ): Promise<void> {
    if (!projectId) return; // LogsService requires a projectId (ObjectId)
    try {
      await this.logs.create({
        projectId,
        level: result.success ? 'info' : 'warn',
        message: `chat-tool ${name} ${result.success ? 'executed' : 'failed'}`,
        service: 'chat-tools',
        area: 'mutation',
        metadata: {
          tool: name,
          // Truncate args and result so a runaway LLM can't flood the log table.
          args: JSON.stringify(args).slice(0, 2000),
          error: result.error,
        },
        tags: ['chat', 'write-tool', name],
      });
    } catch (err) {
      this.logger.warn(`Audit log failed for ${name}: ${(err as Error).message}`);
    }
  }

  /** Returns OpenAI-formatted tool list, filtered by allowlist */
  getToolsForLlm(allowlist: string[]): OpenAiTool[] {
    const allowed = new Set(allowlist);
    return ALL_TOOL_NAMES
      .filter((name) => allowed.has(name))
      .map((name) => ({ type: 'function' as const, function: TOOL_DEFINITIONS[name] }));
  }

  /** Execute a tool call. Returns success/error wrapper, never throws. */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    allowlist: string[],
  ): Promise<ToolExecutionResult> {
    if (PERMANENTLY_BLOCKED_TOOLS.has(name)) {
      return { success: false, error: `Tool "${name}" is permanently blocked for chat` };
    }
    if (!allowlist.includes(name)) {
      return { success: false, error: `Tool "${name}" is not in the allowlist` };
    }
    const isWrite = WRITE_TOOL_NAMES.has(name);
    // Session-projectId overrides any args.projectId for write tools — prevents an
    // LLM from mutating data in projects other than the current chat session.
    const projectId = isWrite
      ? ctx.projectId || undefined
      : (args.projectId as string | undefined) || ctx.projectId || undefined;
    const effectiveArgs = isWrite ? { ...args, projectId } : args;

    const result = await this.dispatch(name, effectiveArgs, projectId);
    if (isWrite) {
      // Don't block the caller on the audit log.
      void this.auditWrite(name, projectId, effectiveArgs, result);
    }
    return result;
  }

  /** Internal: the actual tool dispatch table. Assumes authorization + projectId checks already ran. */
  private async dispatch(
    name: string,
    args: Record<string, unknown>,
    projectId: string | undefined,
  ): Promise<ToolExecutionResult> {
    try {
      switch (name) {
        case 'todo_list': {
          const todos = await this.todos.findAll({
            projectId,
            status: args.status as never,
            priority: args.priority as string | undefined,
            milestoneId: args.milestoneId as string | undefined,
            tag: args.tag as string | undefined,
            includeArchived: args.includeArchived as boolean | undefined,
          });
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          const trimmed = todos.slice(0, limit).map((t) => ({
            id: t._id.toString(),
            number: t.number,
            title: t.title,
            status: t.status,
            priority: t.priority,
            tags: t.tags,
            milestoneId: t.milestoneId?.toString(),
          }));
          return { success: true, result: { count: todos.length, items: trimmed } };
        }
        case 'todo_get': {
          const t = await this.todos.findById(args.id as string);
          return {
            success: true,
            result: {
              id: t._id.toString(),
              title: t.title,
              description: t.description,
              status: t.status,
              priority: t.priority,
              tags: t.tags,
              milestoneId: t.milestoneId?.toString(),
              comments: t.comments,
              blockedBy: t.blockedBy?.map((b) => b.toString()),
            },
          };
        }
        case 'milestone_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.milestones.findByProject(
            projectId,
            args.status as never,
            args.includeArchived as boolean | undefined,
          );
          return {
            success: true,
            result: items.map((m) => ({
              id: m._id.toString(),
              name: m.name,
              status: m.status,
              dueDate: m.dueDate,
            })),
          };
        }
        case 'milestone_get': {
          const m = await this.milestones.findById(args.id as string);
          return { success: true, result: m.toObject() };
        }
        case 'changelog_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const limit = typeof args.limit === 'number' ? args.limit : 20;
          const items = await this.changelog.findByProject(projectId, limit);
          return {
            success: true,
            result: items.map((c) => ({
              id: c._id.toString(),
              version: c.version,
              summary: c.summary,
              component: c.component,
              changes: c.changes,
              createdAt: (c as unknown as { createdAt?: Date }).createdAt,
            })),
          };
        }
        case 'changelog_get': {
          const c = await this.changelog.findById(args.id as string);
          return { success: true, result: c.toObject() };
        }
        case 'rag_search': {
          const limit = typeof args.limit === 'number' ? args.limit : 10;
          const results = await this.rag.search(
            args.query as string,
            projectId,
            args.entity as string | undefined,
            limit,
          );
          return {
            success: true,
            result: results.map((r) => ({
              id: r.id,
              entity: r.entity,
              title: r.title,
              snippet: r.content.slice(0, 400),
              score: r.score,
            })),
          };
        }
        case 'web_search': {
          const query = args.query as string | undefined;
          if (!query) return { success: false, error: 'query required' };
          const response = await this.webSearch.search({
            query,
            language: args.language as string | undefined,
            categories: args.categories as SearchCategory[] | undefined,
            timeRange: args.timeRange as SearchTimeRange | undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return {
            success: true,
            result: {
              query: response.query,
              totalResults: response.totalResults,
              cached: response.cached,
              results: response.results.map((r) => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet,
                engine: r.engine,
                publishedDate: r.publishedDate,
              })),
            },
          };
        }
        case 'web_fetch': {
          const url = args.url as string | undefined;
          if (!url) return { success: false, error: 'url required' };
          const response = await this.readability.fetch({
            url,
            raw: args.raw as boolean | undefined,
            maxLength: typeof args.maxLength === 'number' ? args.maxLength : undefined,
          });
          return {
            success: true,
            result: {
              title: response.title,
              url: response.url,
              siteName: response.siteName,
              excerpt: response.excerpt,
              publishedDate: response.publishedDate,
              contentLength: response.contentLength,
              cached: response.cached,
              content: response.content,
            },
          };
        }
        case 'knowledge_search': {
          const items = await this.knowledge.search(
            args.query as string,
            projectId,
            args.scope as string | undefined,
          );
          return {
            success: true,
            result: items.slice(0, 20).map((k) => ({
              id: k._id.toString(),
              topic: k.topic,
              category: k.category,
              scope: k.scope,
              snippet: k.content.slice(0, 300),
            })),
          };
        }
        case 'knowledge_get': {
          const k = await this.knowledge.findById(args.id as string);
          return { success: true, result: k.toObject() };
        }
        case 'research_search': {
          const items = await this.research.search(args.query as string, projectId);
          return {
            success: true,
            result: items.slice(0, 20).map((r) => ({
              id: r._id.toString(),
              title: r.title,
              tags: r.tags,
              snippet: r.content.slice(0, 300),
            })),
          };
        }
        case 'research_get': {
          const r = await this.research.findById(args.id as string);
          return { success: true, result: r.toObject() };
        }
        case 'manual_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.manuals.findByProject(projectId, args.category as string | undefined);
          return {
            success: true,
            result: items.map((m) => ({
              id: m._id.toString(),
              title: m.title,
              category: m.category,
              sortOrder: m.sortOrder,
            })),
          };
        }
        case 'manual_get': {
          const m = await this.manuals.findById(args.id as string);
          return { success: true, result: m.toObject() };
        }
        case 'session_get': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const limit = typeof args.limit === 'number' ? args.limit : 3;
          const items = await this.sessions.findByProject(projectId, limit);
          return {
            success: true,
            result: items.map((s) => ({
              id: s._id.toString(),
              summary: s.summary,
              filesChanged: s.filesChanged,
              nextSteps: s.nextSteps,
              openQuestions: s.openQuestions,
              createdAt: (s as unknown as { createdAt?: Date }).createdAt,
            })),
          };
        }
        case 'schema_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.schemas.findByProject(projectId, args.dbType as string | undefined);
          return {
            success: true,
            result: items.map((s) => ({
              id: s._id.toString(),
              name: s.name,
              dbType: s.dbType,
              database: s.database,
              description: s.description,
              version: s.version,
            })),
          };
        }
        case 'schema_get': {
          const s = await this.schemas.findById(args.id as string);
          return { success: true, result: s.toObject() };
        }
        case 'dependency_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.dependencies.findByProject(projectId, {
            packageManager: args.packageManager as never,
            category: args.category as string | undefined,
          });
          return {
            success: true,
            result: items.map((d) => ({
              id: d._id.toString(),
              name: d.name,
              version: d.version,
              packageManager: d.packageManager,
              devDependency: d.devDependency,
              category: d.category,
            })),
          };
        }
        case 'feature_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.features.findByProject(projectId, {
            status: args.status as never,
            category: args.category as string | undefined,
          });
          return {
            success: true,
            result: items.map((f) => ({
              id: f._id.toString(),
              name: f.name,
              status: f.status,
              category: f.category,
              version: f.version,
              priority: f.priority,
            })),
          };
        }

        // -------------------- WRITE TOOLS --------------------

        case 'todo_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const title = args.title as string | undefined;
          if (!title) return { success: false, error: 'title required' };
          const todo = await this.todos.create({
            projectId,
            title,
            description: args.description as string | undefined,
            status: args.status as never,
            priority: args.priority as never,
            tags: args.tags as string[] | undefined,
            milestoneId: args.milestoneId as string | undefined,
          });
          return {
            success: true,
            result: {
              id: todo._id.toString(),
              number: (todo as unknown as { number?: number }).number,
              title: todo.title,
              status: todo.status,
            },
          };
        }
        case 'todo_update': {
          const id = args.id as string | undefined;
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.todos.update(id, {
            title: args.title as string | undefined,
            description: args.description as string | undefined,
            status: args.status as never,
            priority: args.priority as never,
            tags: args.tags as string[] | undefined,
            milestoneId: args.milestoneId as string | undefined,
            archived: args.archived as boolean | undefined,
          });
          return {
            success: true,
            result: { id: updated._id.toString(), status: updated.status, title: updated.title },
          };
        }
        case 'todo_comment': {
          const id = args.id as string | undefined;
          const text = args.text as string | undefined;
          if (!id || !text) return { success: false, error: 'id and text required' };
          const author = (args.author as string | undefined) || 'chat';
          await this.todos.addComment(id, text, author);
          return { success: true, result: { id, commentAdded: true } };
        }
        case 'milestone_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const name = args.name as string | undefined;
          if (!name) return { success: false, error: 'name required' };
          const m = await this.milestones.create({
            projectId,
            name,
            description: args.description as string | undefined,
            dueDate: args.dueDate as string | undefined,
            status: args.status as never,
          });
          return { success: true, result: { id: m._id.toString(), name: m.name, status: m.status } };
        }
        case 'milestone_update': {
          const id = args.id as string | undefined;
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.milestones.update(id, {
            name: args.name as string | undefined,
            description: args.description as string | undefined,
            status: args.status as never,
            dueDate: args.dueDate as string | undefined,
            archived: args.archived as boolean | undefined,
            changelogId: args.changelogId as string | undefined,
          });
          return { success: true, result: { id: updated._id.toString(), status: updated.status } };
        }
        case 'changelog_add': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const changes = args.changes as unknown;
          if (!Array.isArray(changes) || changes.length === 0) {
            return { success: false, error: 'changes (non-empty array) required' };
          }
          const entry = await this.changelog.create({
            projectId,
            changes: changes as string[],
            version: args.version as string | undefined,
            summary: args.summary as string | undefined,
            component: args.component as string | undefined,
          });
          return { success: true, result: { id: entry._id.toString(), version: entry.version } };
        }
        case 'knowledge_save': {
          const topic = args.topic as string | undefined;
          const content = args.content as string | undefined;
          if (!topic || !content) return { success: false, error: 'topic and content required' };
          const scope = args.scope as 'global' | 'project' | undefined;
          const dto: Record<string, unknown> = {
            topic,
            content,
            tags: args.tags as string[] | undefined,
            category: args.category as string | undefined,
            scope,
          };
          if (projectId) dto.projectId = projectId;
          const entry = await this.knowledge.create(dto as never);
          return {
            success: true,
            result: {
              id: entry._id.toString(),
              topic: entry.topic,
              scope: entry.scope,
            },
          };
        }
        case 'knowledge_update': {
          const id = args.id as string | undefined;
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.knowledge.update(id, {
            topic: args.topic as string | undefined,
            content: args.content as string | undefined,
            tags: args.tags as string[] | undefined,
            category: args.category as string | undefined,
          });
          return { success: true, result: { id: updated._id.toString(), topic: updated.topic } };
        }
        case 'research_save': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const title = args.title as string | undefined;
          const content = args.content as string | undefined;
          if (!title || !content) return { success: false, error: 'title and content required' };
          const entry = await this.research.create({
            projectId,
            title,
            content,
            sources: args.sources as string[] | undefined,
            tags: args.tags as string[] | undefined,
          });
          return { success: true, result: { id: entry._id.toString(), title: entry.title } };
        }
        case 'manual_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const title = args.title as string | undefined;
          if (!title) return { success: false, error: 'title required' };
          const entry = await this.manuals.create({
            projectId,
            title,
            content: args.content as string | undefined,
            category: args.category as string | undefined,
            sortOrder: args.sortOrder as number | undefined,
          });
          return { success: true, result: { id: entry._id.toString(), title: entry.title } };
        }
        case 'manual_update': {
          const id = args.id as string | undefined;
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.manuals.update(id, {
            title: args.title as string | undefined,
            content: args.content as string | undefined,
            category: args.category as string | undefined,
            sortOrder: args.sortOrder as number | undefined,
          });
          return { success: true, result: { id: updated._id.toString(), title: updated.title } };
        }
        case 'session_save': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const summary = args.summary as string | undefined;
          if (!summary) return { success: false, error: 'summary required' };
          const s = await this.sessions.create({
            projectId,
            summary,
            filesChanged: args.filesChanged as string[] | undefined,
            nextSteps: args.nextSteps as string[] | undefined,
            openQuestions: args.openQuestions as string[] | undefined,
          });
          return { success: true, result: { id: s._id.toString() } };
        }
        case 'feature_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const featureName = args.name as string | undefined;
          if (!featureName) return { success: false, error: 'name required' };
          const f = await this.features.create({
            projectId,
            name: featureName,
            description: args.description as string | undefined,
            category: args.category as string | undefined,
            status: args.status as never,
            version: args.version as string | undefined,
            priority: args.priority as never,
            tags: args.tags as string[] | undefined,
          });
          return { success: true, result: { id: f._id.toString(), name: f.name } };
        }
        case 'feature_update': {
          const id = args.id as string | undefined;
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.features.update(id, {
            name: args.name as string | undefined,
            description: args.description as string | undefined,
            category: args.category as string | undefined,
            status: args.status as never,
            version: args.version as string | undefined,
            priority: args.priority as never,
            tags: args.tags as string[] | undefined,
          });
          return { success: true, result: { id: updated._id.toString(), name: updated.name } };
        }
        case 'dependency_add': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const depName = args.name as string | undefined;
          const version = args.version as string | undefined;
          const packageManager = args.packageManager as string | undefined;
          if (!depName || !version || !packageManager) {
            return { success: false, error: 'name, version, and packageManager required' };
          }
          const d = await this.dependencies.create({
            projectId,
            name: depName,
            version,
            packageManager: packageManager as never,
            description: args.description as string | undefined,
            devDependency: args.devDependency as boolean | undefined,
            category: args.category as string | undefined,
            tags: args.tags as string[] | undefined,
          });
          return { success: true, result: { id: d._id.toString(), name: d.name, version: d.version } };
        }

        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      // T-61: full error stays in server log for debugging; client gets a
      // generic message so we don't leak DB schema, query internals, or paths.
      this.logger.warn(`Tool "${name}" failed: ${errMessage}`);
      return { success: false, error: 'Tool execution failed. Check server logs for details.' };
    }
  }
}

// Type helpers for TodosService / MilestonesService argument casting
type TodoStatusArg = 'open' | 'in_progress' | 'review' | 'done' | undefined;
type MilestoneStatusArg = 'open' | 'in_progress' | 'done' | undefined;
