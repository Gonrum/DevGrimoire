import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { TodosService } from '../todos/todos.service';
import { MilestonesService, type ParsedMilestone, type ParsedTodo } from '../milestones/milestones.service';
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
import { WorkspacesService } from '../workspaces/workspaces.service';
import { WorkspaceClient } from '../workspaces/workspace-client.service';
import { WorkspaceGitTokensService } from '../workspaces/workspace-git-tokens.service';
import { WorkspaceCliTokenService } from '../workspaces/workspace-cli-token.service';
import { SnippetsService } from '../snippets/snippets.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { RecurringTasksService } from '../recurring-tasks/recurring-tasks.service';
import { ReleasesService } from '../releases/releases.service';
import { SoulsService } from '../souls/souls.service';
import { CommitsService } from '../commits/commits.service';
import { CustomersService } from '../customers/customers.service';
import { ContactsService } from '../contacts/contacts.service';
import { QuestionsService } from '../questions/questions.service';
import { StacksService } from '../stacks/stacks.service';
import { TodoPriority, TodoStatus } from '../todos/schemas/todo.schema';
import { MilestoneStatus } from '../milestones/schemas/milestone.schema';
import { FeaturePriority, FeatureStatus } from '../features/schemas/feature.schema';
import { PackageManager } from '../dependencies/schemas/dependency.schema';
import { ReleasePlatform, ReleaseStatus, ReleaseType } from '../releases/schemas/release.schema';
import { CustomerStatus } from '../customers/schemas/customer.schema';
import { RecurringFrequency } from '../recurring-tasks/schemas/recurring-task.schema';
import { WORKSPACE_STATUSES } from '../workspaces/schemas/workspace.schema';
import type { QuestionDirection } from '../questions/schemas/question.schema';
import type { CreateKnowledgeDto } from '../knowledge/dto/create-knowledge.dto';
import {
  idToString,
  isUnknownArray,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalObject,
  optionalObjectArray,
  optionalString,
  optionalStringArray,
  requireEnum,
  requireString,
  type ToolArgs,
} from '../common/tool-args';

/**
 * Wert-Listen für Unions, die — anders als die Schema-Enums — kein Laufzeit-Objekt
 * haben. `optionalEnum` braucht die erlaubten Werte als Array; ohne diese Listen
 * bliebe nur eine Assertion.
 */
const QUESTION_DIRECTIONS: readonly QuestionDirection[] = ['agent_to_user', 'user_to_agent'];
const SEARCH_CATEGORIES: readonly SearchCategory[] = ['general', 'news', 'science', 'it', 'files'];
const SEARCH_TIME_RANGES: readonly SearchTimeRange[] = ['day', 'week', 'month', 'year'];
/**
 * `CreateKnowledgeDto.scope` kennt zusätzlich `customer`; der Chat-Tool-Schema
 * bietet es nicht an, also wird es hier auch nicht akzeptiert.
 */
const KNOWLEDGE_SCOPES: readonly ('global' | 'project')[] = ['global', 'project'];

/**
 * Tools split by read/write so the Settings UI can surface write tools with a
 * distinct warning. Write tools let the chat LLM mutate DevGrimoire data —
 * keep them opt-in by default (see DEFAULT_TOOLS_ALLOWLIST in chat-llm.service.ts).
 */
export const TOOL_GROUPS: Record<
  | 'tasks_read'
  | 'tasks_write'
  | 'knowledge_read'
  | 'knowledge_write'
  | 'project_read'
  | 'project_write'
  | 'customer_read'
  | 'customer_write'
  | 'workspace_read'
  | 'workspace_write'
  | 'external_read'
  | 'stacks_read'
  | 'stacks_write',
  string[]
> = {
  tasks_read: [
    'todo_list', 'todo_get', 'milestone_list', 'milestone_get',
    'changelog_list', 'changelog_get',
    'recurring_task_list', 'recurring_task_get',
    'question_list', 'question_get',
  ],
  tasks_write: [
    'todo_create', 'todo_update', 'todo_comment',
    'milestone_create', 'milestone_update',
    'milestone_create_with_todos', 'milestone_import_apply', 'milestone_import_preview',
    'changelog_add',
    'recurring_task_create', 'recurring_task_update',
    'question_answer',
  ],
  knowledge_read: [
    'rag_search',
    'knowledge_search', 'knowledge_get',
    'research_search', 'research_get',
    'manual_list', 'manual_get',
    'snippet_list', 'snippet_get', 'snippet_search',
  ],
  knowledge_write: [
    'knowledge_save', 'knowledge_update',
    'research_save',
    'manual_create', 'manual_update',
    'snippet_save', 'snippet_update',
  ],
  project_read: [
    'session_get',
    'schema_list', 'schema_get',
    'dependency_list', 'feature_list',
    'soul_get',
    'commit_list', 'commit_search',
    'log_list', 'log_search', 'log_stats',
    'release_list', 'release_get',
    'attachment_list', 'attachment_get', 'attachment_download',
  ],
  project_write: [
    'session_save',
    'feature_create', 'feature_update',
    'dependency_add',
    'soul_update',
    'commit_sync',
    'attachment_upload',
    'release_create', 'release_update', 'release_sync_gitlab',
  ],
  customer_read: [
    'customer_list', 'customer_get',
    'customer_project_list', 'project_customer_links',
    'contact_list', 'contact_get',
  ],
  customer_write: [
    'customer_create', 'customer_update', 'customer_archive',
    'customer_project_link', 'customer_project_update', 'customer_project_unlink',
    'contact_create', 'contact_update', 'contact_delete',
  ],
  workspace_read: [
    'workspace_list', 'workspace_get',
    'workspace_tree', 'workspace_read', 'workspace_search', 'workspace_status',
  ],
  workspace_write: [
    'workspace_create', 'workspace_update', 'workspace_archive', 'workspace_delete',
    'workspace_clone', 'workspace_pull', 'workspace_exec', 'workspace_attachment_save',
  ],
  external_read: ['web_search', 'web_fetch'],
  stacks_read: ['stack_list', 'stack_get', 'stack_export_markdown'],
  stacks_write: ['stack_create', 'stack_update', 'stack_entry_add', 'stack_entry_update', 'stack_entry_remove'],
};

export const ALL_TOOL_NAMES: string[] = Object.values(TOOL_GROUPS).flat();

/** Tools that mutate state — used by the UI to apply warning styling + confirmation. */
// milestone_import_preview is read-only but listed in tasks_write for allowlist purposes;
// it does not mutate state so it is excluded from WRITE_TOOL_NAMES.
export const WRITE_TOOL_NAMES: Set<string> = new Set([
  ...TOOL_GROUPS.tasks_write.filter((t) => t !== 'milestone_import_preview'),
  ...TOOL_GROUPS.knowledge_write,
  ...TOOL_GROUPS.project_write,
  ...TOOL_GROUPS.customer_write,
  ...TOOL_GROUPS.workspace_write,
  ...TOOL_GROUPS.stacks_write,
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
  'stack_delete',
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
    description: 'Lädt vollständigen Todo mit Beschreibung und Kommentaren. Akzeptiert MongoDB-ID oder im Projektkontext eine Todo-Nummer wie T-223.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Todo MongoDB ID oder Display-Nummer (z.B. T-223)' } },
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
  question_list: {
    name: 'question_list',
    description: 'Listet offene Rückfragen (Agent→User oder User→Agent) — gefiltert nach Todo, Projekt, Richtung. Nutze dies, um vor dem Weiterarbeiten an einem Todo zu prüfen, ob der User noch offene Folgefragen hinterlegt hat.',
    parameters: {
      type: 'object',
      properties: {
        todoId: { type: 'string', description: 'Filter: ein einzelnes Todo' },
        projectId: PROJECT_ID_PROP,
        direction: { type: 'string', enum: ['agent_to_user', 'user_to_agent'], description: 'Richtungsfilter — meist user_to_agent, um User-Folgefragen zu finden' },
        includeAnswered: { type: 'boolean', description: 'Auch beantwortete einbeziehen (default false)' },
        limit: { type: 'number', description: 'Default 50' },
      },
    },
  },
  question_get: {
    name: 'question_get',
    description: 'Lädt eine einzelne Rückfrage inkl. Antwort (falls vorhanden).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  question_answer: {
    name: 'question_answer',
    description: 'Beantwortet eine User→Agent Folgefrage auf einem Todo. Verwende dies, wenn der User über die Todo-Detailansicht eine Frage hinterlegt hat. Antwort wird als Kommentar am Todo dokumentiert.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Question MongoDB ID' },
        answer: { type: 'string', description: 'Antworttext (Markdown unterstützt)' },
      },
      required: ['id', 'answer'],
    },
  },
  rag_search: {
    name: 'rag_search',
    description: 'Semantische Suche über alle indizierten Einträge (Knowledge, Research, Manual, Changelog, Todo, Session, Snippet, Attachment, Schema).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
        projectId: PROJECT_ID_PROP,
        entity: { type: 'string', enum: ['knowledge', 'research', 'manual', 'changelog', 'todo', 'session', 'snippet', 'attachment', 'schema'] },
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

  // --- Stacks ---
  stack_list: {
    name: 'stack_list',
    description: 'List all stacks (blueprints), metadata only.',
    parameters: { type: 'object', properties: {} },
  },
  stack_get: {
    name: 'stack_get',
    description: 'Get a stack with all its section entries.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  stack_export_markdown: {
    name: 'stack_export_markdown',
    description: 'Export a stack (or a single section via entryId) as Markdown.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, entryId: { type: 'string' } },
      required: ['id'],
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
  milestone_import_preview: {
    name: 'milestone_import_preview',
    description: 'Parse a Markdown string (milestone export format) and return the structured ParsedMilestone — no DB write. Use this to inspect what would be imported before calling milestone_import_apply.',
    parameters: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'Markdown content to parse (e.g. from milestone_export)' },
      },
      required: ['markdown'],
    },
  },
  milestone_import_apply: {
    name: 'milestone_import_apply',
    description: 'Import a parsed milestone into a project — creates the milestone and all todos. Pass the ParsedMilestone from milestone_import_preview (or a manually crafted object). Returns { milestone, todos, warnings? }.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        parsed: {
          type: 'object',
          description: 'ParsedMilestone object (name, description?, todos[])',
        },
      },
      required: ['parsed'],
    },
  },
  milestone_create_with_todos: {
    name: 'milestone_create_with_todos',
    description: 'Create a milestone with todos in one shot. Each todo can carry the new Quest fields (userStories, acceptanceCriteria[{text, done?}], outOfScope, edgeCases, tags, priority). Intended for the Briefing-Mode flow where the agent has interactively gathered structured requirements with the user.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        name: { type: 'string', description: 'Milestone name' },
        description: { type: 'string', description: 'Optional milestone description (markdown)' },
        todos: {
          type: 'array',
          description: 'Array of todo objects. Each may include: title (required), description, priority (low/medium/high/critical), tags[], userStories, acceptanceCriteria ([{text, done?}]), outOfScope, edgeCases.',
          items: { type: 'object' },
        },
      },
      required: ['name', 'todos'],
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

  // --- Recurring tasks ---
  recurring_task_list: {
    name: 'recurring_task_list',
    description: 'Listet wiederkehrende Tasks (compact).',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID_PROP } },
  },
  recurring_task_get: {
    name: 'recurring_task_get',
    description: 'Lädt einen Recurring Task mit allen Feldern.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  recurring_task_create: {
    name: 'recurring_task_create',
    description: 'Legt einen Recurring Task an. Mit projectId: erzeugt Todos. Ohne: System-Notification.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        milestoneId: { type: 'string' },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
        weekday: { type: 'number' },
        monthDay: { type: 'number' },
      },
      required: ['title', 'frequency'],
    },
  },
  recurring_task_update: {
    name: 'recurring_task_update',
    description: 'Aktualisiert einen Recurring Task.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        active: { type: 'boolean' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },

  // --- Snippets ---
  snippet_list: {
    name: 'snippet_list',
    description: 'Listet Code-Snippets (compact, ohne Code-Body).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        language: { type: 'string' },
        category: { type: 'string' },
        tag: { type: 'string' },
      },
    },
  },
  snippet_get: {
    name: 'snippet_get',
    description: 'Lädt einen Snippet inkl. Code.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  snippet_search: {
    name: 'snippet_search',
    description: 'Volltext-Suche über Snippets (Code + Title + Description).',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' }, projectId: PROJECT_ID_PROP },
      required: ['q'],
    },
  },
  snippet_save: {
    name: 'snippet_save',
    description: 'Speichert einen Code-Snippet.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        title: { type: 'string' },
        language: { type: 'string', description: 'lowercase, z.B. typescript, python, sql, bash' },
        code: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        fileName: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'language', 'code'],
    },
  },
  snippet_update: {
    name: 'snippet_update',
    description: 'Aktualisiert einen Snippet.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        language: { type: 'string' },
        code: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },

  // --- Soul ---
  soul_get: {
    name: 'soul_get',
    description: 'Lädt die Project Soul (Vision, Prinzipien, Konventionen, Boundaries). null wenn nicht definiert.',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID_PROP } },
  },
  soul_update: {
    name: 'soul_update',
    description: 'Setzt/aktualisiert die Project Soul (partial update — nur die übergebenen Sections werden geändert).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        vision: { type: 'string' },
        principles: { type: 'string' },
        conventions: { type: 'string' },
        communication: { type: 'string' },
        boundaries: { type: 'string' },
        workflow: { type: 'string' },
        quality: { type: 'string' },
      },
    },
  },

  // --- Commits ---
  commit_list: {
    name: 'commit_list',
    description: 'Listet Commits (compact: shortSha, message, author, date, repoLabel). Aus GitHub/GitLab synced.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        limit: { type: 'number', description: 'Default 50' },
        repoLabel: { type: 'string' },
      },
    },
  },
  commit_search: {
    name: 'commit_search',
    description: 'Volltext-Suche in Commit-Messages.',
    parameters: {
      type: 'object',
      properties: { projectId: PROJECT_ID_PROP, q: { type: 'string' } },
      required: ['q'],
    },
  },
  commit_sync: {
    name: 'commit_sync',
    description: 'Triggert manuelle Commit-Synchronisation aus konfigurierten Git-Repositories.',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID_PROP } },
  },

  // --- Logs ---
  log_list: {
    name: 'log_list',
    description: 'Listet Application-Logs (kommen von externen Apps via API-Key, TTL 5 Tage).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
        service: { type: 'string' },
        search: { type: 'string' },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  log_search: {
    name: 'log_search',
    description: 'Volltext-Suche über Logs (alias für log_list mit search-param).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        q: { type: 'string' },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
      },
      required: ['q'],
    },
  },
  log_stats: {
    name: 'log_stats',
    description: 'Log-Statistiken: Total, breakdown nach Level + Service, oldest/newest.',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID_PROP } },
  },

  // --- Releases ---
  release_list: {
    name: 'release_list',
    description: 'Listet Releases (compact).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        status: { type: 'string', enum: ['draft', 'published', 'archived'] },
        platform: { type: 'string' },
        releaseType: { type: 'string', enum: ['manual', 'gitlab'] },
      },
    },
  },
  release_get: {
    name: 'release_get',
    description: 'Lädt ein Release mit Description und Assets.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  release_create: {
    name: 'release_create',
    description: 'Legt ein Release an (manual oder gitlab-synced).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        version: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        releaseType: { type: 'string', enum: ['manual', 'gitlab'] },
        platform: { type: 'string', enum: ['android', 'ios', 'web', 'desktop', 'docker', 'other'] },
        status: { type: 'string', enum: ['draft', 'published', 'archived'] },
        downloadUrl: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['version'],
    },
  },
  release_update: {
    name: 'release_update',
    description: 'Aktualisiert ein Release.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published', 'archived'] },
      },
      required: ['id'],
    },
  },
  release_sync_gitlab: {
    name: 'release_sync_gitlab',
    description: 'Synchronisiert Releases aus konfigurierten Git-Repos (GitHub/GitLab/Gitea). Alias-Name (wird in nächster Release umbenannt).',
    parameters: {
      type: 'object',
      properties: { projectId: PROJECT_ID_PROP, repoIndex: { type: 'number' } },
    },
  },

  // --- Attachments ---
  attachment_list: {
    name: 'attachment_list',
    description: 'Listet Datei-Attachments. Filter optional nach entityType/entityId.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        entityType: { type: 'string' },
        entityId: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  attachment_get: {
    name: 'attachment_get',
    description: 'Metadaten einer Datei (kein Inhalt).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  attachment_download: {
    name: 'attachment_download',
    description: 'Lädt Inhalt einer Datei. Text-Files direkt, Binärdateien als base64 (max 5MB).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  attachment_upload: {
    name: 'attachment_upload',
    description: 'Lädt eine Datei hoch (content base64-encoded). Optional an Entity heften (entityType+entityId).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        fileName: { type: 'string' },
        content: { type: 'string', description: 'base64-encoded' },
        mimeType: { type: 'string' },
        entityType: { type: 'string' },
        entityId: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['fileName', 'content'],
    },
  },

  // --- Workspaces (M-22) ---
  workspace_list: {
    name: 'workspace_list',
    description: 'Listet Workspaces eines Projekts. Filter nach Status.',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        status: { type: 'string', enum: ['active', 'archived', 'cleaning'] },
      },
    },
  },
  workspace_get: {
    name: 'workspace_get',
    description: 'Lädt einen Workspace (id ODER projectId+name).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, projectId: PROJECT_ID_PROP, name: { type: 'string' } },
    },
  },
  workspace_create: {
    name: 'workspace_create',
    description: 'Legt einen Workspace an. Name muss slug-kompatibel sein ([a-z0-9][a-z0-9_-]*).',
    parameters: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROP,
        name: { type: 'string' },
        description: { type: 'string' },
        repoUrl: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['name'],
    },
  },
  workspace_update: {
    name: 'workspace_update',
    description: 'Aktualisiert Workspace-Metadaten.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        repoUrl: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['id'],
    },
  },
  workspace_archive: {
    name: 'workspace_archive',
    description: 'Archiviert einen Workspace (status=archived). Disk bleibt.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  workspace_delete: {
    name: 'workspace_delete',
    description: 'Hard-Delete eines Workspaces. Backend fragt User vor Ausführung via ask_user. Returns {deleted:false, aborted:true} bei Cancel.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  workspace_clone: {
    name: 'workspace_clone',
    description: 'Klont ein Repo (depth=1). Schlägt fehl wenn Workspace schon ein Repo hat — dann workspace_pull.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, repoUrl: { type: 'string' }, branch: { type: 'string' } },
      required: ['id', 'repoUrl'],
    },
  },
  workspace_pull: {
    name: 'workspace_pull',
    description: 'git pull --ff-only.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  workspace_tree: {
    name: 'workspace_tree',
    description: 'Directory-Tree (depth default 3, max 8). Skip .git.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, path: { type: 'string' }, depth: { type: 'number' } },
      required: ['id'],
    },
  },
  workspace_read: {
    name: 'workspace_read',
    description: 'Liest eine Datei (UTF-8, max 5MB). Path-Traversal blocked.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, path: { type: 'string' } },
      required: ['id', 'path'],
    },
  },
  workspace_search: {
    name: 'workspace_search',
    description: 'ripgrep über den Workspace. Optional include/exclude globs.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        query: { type: 'string' },
        include: { type: 'array', items: { type: 'string' } },
        exclude: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'query'],
    },
  },
  workspace_status: {
    name: 'workspace_status',
    description: 'git status --porcelain --branch.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  workspace_exec: {
    name: 'workspace_exec',
    description: 'Shell-Command im Sandbox-Container. Default-Timeout 60s, max 600s. Blacklist + scrubbed env. Audit-logged.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        command: { type: 'string' },
        timeout: { type: 'number' },
        env: { type: 'object', description: 'Optional env vars (keys [A-Z_][A-Z0-9_]*, values <=4KB).' },
      },
      required: ['id', 'command'],
    },
  },
  workspace_attachment_save: {
    name: 'workspace_attachment_save',
    description: 'Datei aus dem Workspace ins Project-Attachments (MinIO) übernehmen. Binär-safe. Optional an Entity (todo/release) verlinken.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Workspace ID' },
        path: { type: 'string', description: 'Pfad relativ zum Workspace-Root' },
        fileName: { type: 'string' },
        entityType: { type: 'string' },
        entityId: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'path'],
    },
  },

  // --- Stacks (write) ---
  stack_create: {
    name: 'stack_create',
    description: 'Create a new stack definition.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' } },
      required: ['name'],
    },
  },
  stack_update: {
    name: 'stack_update',
    description: 'Update a stack name/description.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
      required: ['id'],
    },
  },
  stack_entry_add: {
    name: 'stack_entry_add',
    description: 'Add a section entry to a stack.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } },
      required: ['id', 'title'],
    },
  },
  stack_entry_update: {
    name: 'stack_entry_update',
    description: 'Update a section entry.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' }, entryId: { type: 'string' },
        title: { type: 'string' }, content: { type: 'string' }, order: { type: 'number' },
      },
      required: ['id', 'entryId'],
    },
  },
  stack_entry_remove: {
    name: 'stack_entry_remove',
    description: 'Remove a section entry from a stack.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, entryId: { type: 'string' } },
      required: ['id', 'entryId'],
    },
  },

  // ---------------------------------------------------------------------------
  // Kunden-Kontext (read-only)
  //
  // Diese sechs Tools standen in TOOL_GROUPS und in DEFAULT_TOOLS_ALLOWLIST und
  // haben funktionierende dispatch()-Cases — es fehlten nur ihre Definitionen
  // hier. `getToolsForLlm` baute daraus `{ type: 'function', function: undefined }`,
  // und der Anthropic-Adapter in llm-client.service.ts liest `t.function.name`:
  // jeder tool-fähige Chat mit der Default-Allowlist lief damit in einen
  // TypeError. Sichtbar wurde das erst, als die Casts fielen — `Record<string,
  // ToolDefinition>` verspricht eine totale Index-Signatur, und `tsconfig.json`
  // hat kein `noUncheckedIndexedAccess`.
  // ---------------------------------------------------------------------------
  customer_list: {
    name: 'customer_list',
    description:
      'Listet Kunden. Filter nach Status, Tag, Freitextsuche und Projekt-Verknüpfung.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['lead', 'onboarding', 'active', 'paused', 'offboarding', 'cancelled'],
          description: 'Filter nach Kundenstatus',
        },
        tag: { type: 'string' },
        q: { type: 'string', description: 'Freitextsuche über Name und Beschreibung' },
        includeArchived: { type: 'boolean' },
        projectId: PROJECT_ID_PROP,
        limit: { type: 'number', description: 'Max. Anzahl (Default 50)' },
      },
    },
  },
  customer_get: {
    name: 'customer_get',
    description: 'Lädt einen Kunden mit Kontaktdaten, Status und Tags.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Customer MongoDB ID' } },
      required: ['id'],
    },
  },
  contact_list: {
    name: 'contact_list',
    description: 'Listet die Kontakte eines Kunden.',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string', description: 'Customer MongoDB ID' } },
      required: ['customerId'],
    },
  },
  contact_get: {
    name: 'contact_get',
    description: 'Lädt einen Kontakt mit Rolle, E-Mail, Telefon und Notizen.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact MongoDB ID' } },
      required: ['id'],
    },
  },
  customer_project_list: {
    name: 'customer_project_list',
    description: 'Listet die Projekt-Verknüpfungen eines Kunden.',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string', description: 'Customer MongoDB ID' } },
      required: ['customerId'],
    },
  },
  project_customer_links: {
    name: 'project_customer_links',
    description:
      'Listet die Kunden-Verknüpfungen eines Projekts. Ohne projectId wird der Chat-Projekt-Kontext verwendet.',
    parameters: {
      type: 'object',
      properties: { projectId: PROJECT_ID_PROP },
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
    private readonly workspaces: WorkspacesService,
    private readonly workspaceClient: WorkspaceClient,
    private readonly workspaceGitTokens: WorkspaceGitTokensService,
    private readonly workspaceCliToken: WorkspaceCliTokenService,
    private readonly snippets: SnippetsService,
    private readonly attachments: AttachmentsService,
    @Inject(forwardRef(() => RecurringTasksService)) private readonly recurringTasks: RecurringTasksService,
    private readonly releases: ReleasesService,
    private readonly souls: SoulsService,
    private readonly commits: CommitsService,
    private readonly customers: CustomersService,
    private readonly contacts: ContactsService,
    private readonly questions: QuestionsService,
    private readonly stacksService: StacksService,
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
      this.logger.warn(
        `Audit log failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Returns OpenAI-formatted tool list, filtered by allowlist */
  getToolsForLlm(allowlist: string[]): OpenAiTool[] {
    const allowed = new Set(allowlist);
    const tools: OpenAiTool[] = [];
    for (const name of ALL_TOOL_NAMES) {
      if (!allowed.has(name)) continue;
      const definition = TOOL_DEFINITIONS[name];
      // Namen ohne Definition werden übersprungen statt als
      // `{ function: undefined }` ausgeliefert. Der Anthropic-Adapter liest
      // `t.function.name` und lief sonst in einen TypeError — eine Lücke
      // zwischen TOOL_GROUPS und TOOL_DEFINITIONS darf höchstens dazu führen,
      // dass ein Tool nicht angeboten wird, nicht den ganzen Chat abschießen.
      if (!definition) {
        this.logger.warn(`Tool "${name}" ist in der Allowlist, hat aber keine Definition`);
        continue;
      }
      tools.push({ type: 'function' as const, function: definition });
    }
    return tools;
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
    // Ein nicht-String in args.projectId zählt wie „nicht gesetzt"; früher wurde er
    // per Assertion durchgereicht und erst in der Query zum Problem.
    const argProjectId = typeof args.projectId === 'string' ? args.projectId : undefined;
    const projectId = isWrite
      ? ctx.projectId || undefined
      : argProjectId || ctx.projectId || undefined;
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
    args: ToolArgs,
    projectId: string | undefined,
  ): Promise<ToolExecutionResult> {
    try {
      switch (name) {
        case 'todo_list': {
          const todos = await this.todos.findAll({
            projectId,
            status: optionalEnum(args, 'status', Object.values(TodoStatus)),
            priority: optionalString(args, 'priority'),
            milestoneId: optionalString(args, 'milestoneId'),
            tag: optionalString(args, 'tag'),
            includeArchived: optionalBoolean(args, 'includeArchived'),
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
          const id = await this.todos.resolveId({ id: requireString(args, 'id'), projectId });
          const t = await this.todos.findById(id);
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
            optionalEnum(args, 'status', Object.values(MilestoneStatus)),
            optionalBoolean(args, 'includeArchived'),
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
          const m = await this.milestones.findById(requireString(args, 'id'));
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
              createdAt: c.createdAt,
            })),
          };
        }
        case 'changelog_get': {
          const c = await this.changelog.findById(requireString(args, 'id'));
          return { success: true, result: c.toObject() };
        }
        case 'question_list': {
          const direction = optionalEnum(args, 'direction', QUESTION_DIRECTIONS);
          const todoId = optionalString(args, 'todoId');
          const includeAnswered = optionalBoolean(args, 'includeAnswered') ?? false;
          if (todoId) {
            const list = await this.questions.findByTodo(todoId, includeAnswered);
            const filtered = direction ? list.filter((q) => q.direction === direction) : list;
            return {
              success: true,
              result: {
                count: filtered.length,
                items: filtered.map((q) => ({
                  id: q._id.toString(),
                  direction: q.direction,
                  status: q.status,
                  question: q.question,
                  options: q.options,
                  context: q.context,
                  answer: q.answer,
                  todoId: q.todoId?.toString(),
                  projectId: q.projectId?.toString(),
                  createdAt: q.createdAt,
                  answeredAt: q.answeredAt,
                })),
              },
            };
          }
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          const open = await this.questions.findOpen({
            projectId,
            direction,
            limit,
          });
          return {
            success: true,
            result: {
              count: open.total,
              items: open.items.map((q) => ({
                id: q._id.toString(),
                direction: q.direction,
                status: q.status,
                question: q.question,
                options: q.options,
                todoId: q.todoId?.toString(),
                projectId: q.projectId?.toString(),
                createdAt: q.createdAt,
              })),
            },
          };
        }
        case 'question_get': {
          const qId = optionalString(args, 'id');
          if (!qId) return { success: false, error: 'id required' };
          const q = await this.questions.findById(qId);
          return {
            success: true,
            result: {
              id: q._id.toString(),
              direction: q.direction,
              status: q.status,
              question: q.question,
              options: q.options,
              context: q.context,
              answer: q.answer,
              todoId: q.todoId?.toString(),
              projectId: q.projectId?.toString(),
              answeredByUserId: q.answeredByUserId?.toString(),
              answeredByAgent: q.answeredByAgent,
              answeredAt: q.answeredAt,
              expiresAt: q.expiresAt,
              createdAt: q.createdAt,
            },
          };
        }
        case 'question_answer': {
          const qId = optionalString(args, 'id');
          const ans = optionalString(args, 'answer');
          if (!qId || !ans) return { success: false, error: 'id and answer required' };
          const updated = await this.questions.answer(
            qId,
            ans,
            { byAgent: true },
          );
          return {
            success: true,
            result: {
              id: updated._id.toString(),
              status: updated.status,
              answer: updated.answer,
              answeredAt: updated.answeredAt,
            },
          };
        }
        case 'rag_search': {
          const limit = typeof args.limit === 'number' ? args.limit : 10;
          const results = await this.rag.search(
            requireString(args, 'query'),
            projectId,
            optionalString(args, 'entity'),
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
          const query = optionalString(args, 'query');
          if (!query) return { success: false, error: 'query required' };
          // `find` liefert den verengten Typ aus einer Laufzeitprüfung — anders als
          // eine Assertion auf SearchCategory[], die auch "foo" durchgelassen hätte.
          const categories = optionalStringArray(args, 'categories')?.map((entry) => {
            const match = SEARCH_CATEGORIES.find((candidate) => candidate === entry);
            if (match === undefined) {
              throw new Error(`categories must contain only: ${SEARCH_CATEGORIES.join(', ')}`);
            }
            return match;
          });
          const response = await this.webSearch.search({
            query,
            language: optionalString(args, 'language'),
            categories,
            timeRange: optionalEnum(args, 'timeRange', SEARCH_TIME_RANGES),
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
          const url = optionalString(args, 'url');
          if (!url) return { success: false, error: 'url required' };
          const response = await this.readability.fetch({
            url,
            raw: optionalBoolean(args, 'raw'),
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
            requireString(args, 'query'),
            projectId,
            optionalString(args, 'scope'),
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
          const k = await this.knowledge.findById(requireString(args, 'id'));
          return { success: true, result: k.toObject() };
        }
        case 'research_search': {
          const items = await this.research.search(requireString(args, 'query'), projectId);
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
          const r = await this.research.findById(requireString(args, 'id'));
          return { success: true, result: r.toObject() };
        }
        case 'manual_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.manuals.findByProject(projectId, optionalString(args, 'category'));
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
          const m = await this.manuals.findById(requireString(args, 'id'));
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
              createdAt: s.createdAt,
            })),
          };
        }
        case 'schema_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.schemas.findByProject(projectId, optionalString(args, 'dbType'));
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
          const s = await this.schemas.findById(requireString(args, 'id'));
          return { success: true, result: s.toObject() };
        }
        case 'dependency_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.dependencies.findByProject(projectId, {
            packageManager: optionalEnum(args, 'packageManager', Object.values(PackageManager)),
            category: optionalString(args, 'category'),
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
            status: optionalEnum(args, 'status', Object.values(FeatureStatus)),
            category: optionalString(args, 'category'),
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
          const title = optionalString(args, 'title');
          if (!title) return { success: false, error: 'title required' };
          const todo = await this.todos.create({
            projectId,
            title,
            description: optionalString(args, 'description'),
            status: optionalEnum(args, 'status', Object.values(TodoStatus)),
            priority: optionalEnum(args, 'priority', Object.values(TodoPriority)),
            tags: optionalStringArray(args, 'tags'),
            milestoneId: optionalString(args, 'milestoneId'),
          });
          return {
            success: true,
            result: {
              id: todo._id.toString(),
              number: todo.number,
              title: todo.title,
              status: todo.status,
            },
          };
        }
        case 'todo_update': {
          const id = optionalString(args, 'id');
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.todos.update(id, {
            title: optionalString(args, 'title'),
            description: optionalString(args, 'description'),
            status: optionalEnum(args, 'status', Object.values(TodoStatus)),
            priority: optionalEnum(args, 'priority', Object.values(TodoPriority)),
            tags: optionalStringArray(args, 'tags'),
            milestoneId: optionalString(args, 'milestoneId'),
            archived: optionalBoolean(args, 'archived'),
          });
          return {
            success: true,
            result: { id: updated._id.toString(), status: updated.status, title: updated.title },
          };
        }
        case 'todo_comment': {
          const id = optionalString(args, 'id');
          const text = optionalString(args, 'text');
          if (!id || !text) return { success: false, error: 'id and text required' };
          const author = optionalString(args, 'author') || 'chat';
          await this.todos.addComment(id, text, author);
          return { success: true, result: { id, commentAdded: true } };
        }
        case 'milestone_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const name = optionalString(args, 'name');
          if (!name) return { success: false, error: 'name required' };
          const m = await this.milestones.create({
            projectId,
            name,
            description: optionalString(args, 'description'),
            dueDate: optionalString(args, 'dueDate'),
            status: optionalEnum(args, 'status', Object.values(MilestoneStatus)),
          });
          return { success: true, result: { id: m._id.toString(), name: m.name, status: m.status } };
        }
        case 'milestone_update': {
          const id = optionalString(args, 'id');
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.milestones.update(id, {
            name: optionalString(args, 'name'),
            description: optionalString(args, 'description'),
            status: optionalEnum(args, 'status', Object.values(MilestoneStatus)),
            dueDate: optionalString(args, 'dueDate'),
            archived: optionalBoolean(args, 'archived'),
            changelogId: optionalString(args, 'changelogId'),
          });
          return { success: true, result: { id: updated._id.toString(), status: updated.status } };
        }
        case 'milestone_import_preview': {
          const markdown = optionalString(args, 'markdown');
          if (!markdown) return { success: false, error: 'markdown required' };
          const parsed = this.milestones.parseMarkdown(markdown);
          return { success: true, result: parsed };
        }
        case 'milestone_import_apply': {
          if (!projectId) return { success: false, error: 'projectId required' };
          // Nur die Form wird hier geprüft (Objekt, name-String, todos-Array); die
          // Struktur der einzelnen Todos validiert importFromParsed/CreateTodoDto.
          const parsed = optionalObject<ParsedMilestone>(args, 'parsed');
          if (!parsed || typeof parsed.name !== 'string' || !parsed.name || !isUnknownArray(parsed.todos)) {
            return { success: false, error: 'parsed (with name and todos[]) required' };
          }
          const importResult = await this.milestones.importFromParsed(projectId, parsed);
          return {
            success: true,
            result: {
              milestone: { id: importResult.milestone._id.toString(), name: importResult.milestone.name },
              todos: importResult.todos.map((t) => ({ id: t._id.toString(), title: t.title })),
              warnings: importResult.warnings,
            },
          };
        }
        case 'milestone_create_with_todos': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const msName = optionalString(args, 'name');
          if (!msName) return { success: false, error: 'name required' };
          const todos = isUnknownArray(args.todos)
            ? optionalObjectArray<ParsedTodo>(args, 'todos')
            : undefined;
          if (!todos) return { success: false, error: 'todos (array) required' };
          const importResult = await this.milestones.importFromParsed(projectId, {
            name: msName,
            description: optionalString(args, 'description'),
            todos,
          });
          return {
            success: true,
            result: {
              milestone: { id: importResult.milestone._id.toString(), name: importResult.milestone.name },
              todos: importResult.todos.map((t) => ({ id: t._id.toString(), title: t.title })),
              warnings: importResult.warnings,
            },
          };
        }
        case 'changelog_add': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const changes = optionalStringArray(args, 'changes');
          if (!changes || changes.length === 0) {
            return { success: false, error: 'changes (non-empty array) required' };
          }
          const entry = await this.changelog.create({
            projectId,
            changes,
            version: optionalString(args, 'version'),
            summary: optionalString(args, 'summary'),
            component: optionalString(args, 'component'),
          });
          return { success: true, result: { id: entry._id.toString(), version: entry.version } };
        }
        case 'knowledge_save': {
          const topic = optionalString(args, 'topic');
          const content = optionalString(args, 'content');
          if (!topic || !content) return { success: false, error: 'topic and content required' };
          const dto: CreateKnowledgeDto = {
            topic,
            content,
            tags: optionalStringArray(args, 'tags'),
            category: optionalString(args, 'category'),
            scope: optionalEnum(args, 'scope', KNOWLEDGE_SCOPES),
          };
          if (projectId) dto.projectId = projectId;
          const entry = await this.knowledge.create(dto);
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
          const id = optionalString(args, 'id');
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.knowledge.update(id, {
            topic: optionalString(args, 'topic'),
            content: optionalString(args, 'content'),
            tags: optionalStringArray(args, 'tags'),
            category: optionalString(args, 'category'),
          });
          return { success: true, result: { id: updated._id.toString(), topic: updated.topic } };
        }
        case 'research_save': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const title = optionalString(args, 'title');
          const content = optionalString(args, 'content');
          if (!title || !content) return { success: false, error: 'title and content required' };
          const entry = await this.research.create({
            projectId,
            title,
            content,
            sources: optionalStringArray(args, 'sources'),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: entry._id.toString(), title: entry.title } };
        }
        case 'manual_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const title = optionalString(args, 'title');
          if (!title) return { success: false, error: 'title required' };
          const entry = await this.manuals.create({
            projectId,
            title,
            content: optionalString(args, 'content'),
            category: optionalString(args, 'category'),
            sortOrder: optionalNumber(args, 'sortOrder'),
          });
          return { success: true, result: { id: entry._id.toString(), title: entry.title } };
        }
        case 'manual_update': {
          const id = optionalString(args, 'id');
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.manuals.update(id, {
            title: optionalString(args, 'title'),
            content: optionalString(args, 'content'),
            category: optionalString(args, 'category'),
            sortOrder: optionalNumber(args, 'sortOrder'),
          });
          return { success: true, result: { id: updated._id.toString(), title: updated.title } };
        }
        case 'session_save': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const summary = optionalString(args, 'summary');
          if (!summary) return { success: false, error: 'summary required' };
          const s = await this.sessions.create({
            projectId,
            summary,
            filesChanged: optionalStringArray(args, 'filesChanged'),
            nextSteps: optionalStringArray(args, 'nextSteps'),
            openQuestions: optionalStringArray(args, 'openQuestions'),
          });
          return { success: true, result: { id: s._id.toString() } };
        }
        case 'feature_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const featureName = optionalString(args, 'name');
          if (!featureName) return { success: false, error: 'name required' };
          const f = await this.features.create({
            projectId,
            name: featureName,
            description: optionalString(args, 'description'),
            category: optionalString(args, 'category'),
            status: optionalEnum(args, 'status', Object.values(FeatureStatus)),
            version: optionalString(args, 'version'),
            priority: optionalEnum(args, 'priority', Object.values(FeaturePriority)),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: f._id.toString(), name: f.name } };
        }
        case 'feature_update': {
          const id = optionalString(args, 'id');
          if (!id) return { success: false, error: 'id required' };
          const updated = await this.features.update(id, {
            name: optionalString(args, 'name'),
            description: optionalString(args, 'description'),
            category: optionalString(args, 'category'),
            status: optionalEnum(args, 'status', Object.values(FeatureStatus)),
            version: optionalString(args, 'version'),
            priority: optionalEnum(args, 'priority', Object.values(FeaturePriority)),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: updated._id.toString(), name: updated.name } };
        }
        case 'dependency_add': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const depName = optionalString(args, 'name');
          const version = optionalString(args, 'version');
          const packageManager = optionalEnum(args, 'packageManager', Object.values(PackageManager));
          if (!depName || !version || !packageManager) {
            return { success: false, error: 'name, version, and packageManager required' };
          }
          const d = await this.dependencies.create({
            projectId,
            name: depName,
            version,
            packageManager,
            description: optionalString(args, 'description'),
            devDependency: optionalBoolean(args, 'devDependency'),
            category: optionalString(args, 'category'),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: d._id.toString(), name: d.name, version: d.version } };
        }

        // ─── Recurring tasks ─────────────────────────────────────────────
        case 'recurring_task_list': {
          const items = await this.recurringTasks.findAll({
            projectId: projectId || optionalString(args, 'projectId'),
            systemOnly: optionalBoolean(args, 'systemOnly'),
          });
          return {
            success: true,
            result: items.map((r) => ({
              id: r._id.toString(),
              title: r.title,
              frequency: r.frequency,
              active: r.active,
              priority: r.priority,
              tags: r.tags,
              projectId: r.projectId?.toString(),
            })),
          };
        }
        case 'recurring_task_get': {
          const r = await this.recurringTasks.findById(requireString(args, 'id'));
          return { success: true, result: r.toObject() };
        }
        case 'recurring_task_create': {
          if (!projectId && !args.projectId) {
            // System-wide tasks (without projectId) require explicit user opt-in
            // — the chat agent shouldn't be creating cross-project notifications
            // unprompted. Force projectId-scoping like other write tools.
            return { success: false, error: 'projectId required for chat-created recurring tasks' };
          }
          const r = await this.recurringTasks.create({
            projectId: projectId || requireString(args, 'projectId'),
            title: requireString(args, 'title'),
            description: optionalString(args, 'description'),
            priority: optionalString(args, 'priority'),
            tags: optionalStringArray(args, 'tags'),
            milestoneId: optionalString(args, 'milestoneId'),
            frequency: requireEnum(args, 'frequency', Object.values(RecurringFrequency)),
            dayOfWeek: optionalNumber(args, 'weekday'),
            dayOfMonth: optionalNumber(args, 'monthDay'),
          });
          return { success: true, result: { id: r._id.toString(), title: r.title } };
        }
        case 'recurring_task_update': {
          const r = await this.recurringTasks.update(requireString(args, 'id'), {
            title: optionalString(args, 'title'),
            description: optionalString(args, 'description'),
            active: optionalBoolean(args, 'active'),
            priority: optionalString(args, 'priority'),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: r._id.toString(), title: r.title, active: r.active } };
        }

        // ─── Snippets ─────────────────────────────────────────────────────
        case 'snippet_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.snippets.findByProject(
            projectId,
            optionalString(args, 'language'),
            optionalString(args, 'category'),
            optionalString(args, 'tag'),
          );
          return {
            success: true,
            result: items.map((s) => ({
              id: s._id.toString(),
              title: s.title,
              language: s.language,
              category: s.category,
              tags: s.tags,
              fileName: s.fileName,
            })),
          };
        }
        case 'snippet_get': {
          const s = await this.snippets.findById(requireString(args, 'id'));
          return { success: true, result: s.toObject() };
        }
        case 'snippet_search': {
          const items = await this.snippets.search(
            requireString(args, 'q'),
            projectId || optionalString(args, 'projectId'),
          );
          return {
            success: true,
            result: items.map((s) => ({
              id: s._id.toString(),
              title: s.title,
              language: s.language,
              snippet: (s.code || '').slice(0, 200),
            })),
          };
        }
        case 'snippet_save': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const s = await this.snippets.create({
            projectId,
            title: requireString(args, 'title'),
            language: requireString(args, 'language').toLowerCase(),
            code: requireString(args, 'code'),
            description: optionalString(args, 'description'),
            category: optionalString(args, 'category'),
            fileName: optionalString(args, 'fileName'),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: s._id.toString(), title: s.title } };
        }
        case 'snippet_update': {
          // Leerstring bleibt wie bisher „nicht gesetzt" — sonst würde ein
          // `language: ""` das Feld im Dokument leeren.
          const language = optionalString(args, 'language');
          const s = await this.snippets.update(requireString(args, 'id'), {
            title: optionalString(args, 'title'),
            language: language ? language.toLowerCase() : undefined,
            code: optionalString(args, 'code'),
            description: optionalString(args, 'description'),
            category: optionalString(args, 'category'),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: s._id.toString(), title: s.title } };
        }

        // ─── Soul ────────────────────────────────────────────────────────
        case 'soul_get': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const s = await this.souls.findByProject(projectId);
          return { success: true, result: s ? s.toObject() : null };
        }
        case 'soul_update': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const s = await this.souls.upsert({ projectId }, {
            vision: optionalString(args, 'vision'),
            principles: optionalString(args, 'principles'),
            conventions: optionalString(args, 'conventions'),
            communication: optionalString(args, 'communication'),
            boundaries: optionalString(args, 'boundaries'),
            workflow: optionalString(args, 'workflow'),
            quality: optionalString(args, 'quality'),
          });
          return { success: true, result: { id: s._id.toString(), updated: true } };
        }

        // ─── Commits ─────────────────────────────────────────────────────
        case 'commit_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          const items = await this.commits.findByProject(projectId, {
            limit,
            repoLabel: optionalString(args, 'repoLabel'),
          });
          return {
            success: true,
            result: items.map((c) => ({
              shortSha: c.sha.slice(0, 7),
              message: (c.message || '').split('\n')[0],
              // Das Schema-Feld heißt `authorName`; der frühere Cast auf `{author?: string}`
              // hat kompiliert, aber zur Laufzeit immer `undefined` geliefert.
              author: c.authorName,
              date: c.committedAt,
              repoLabel: c.repoLabel,
            })),
          };
        }
        case 'commit_search': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.commits.search(projectId, requireString(args, 'q'));
          return {
            success: true,
            result: items.map((c) => ({
              shortSha: c.sha.slice(0, 7),
              message: (c.message || '').split('\n')[0],
              author: c.authorName,
              date: c.committedAt,
            })),
          };
        }
        case 'commit_sync': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const result = await this.commits.syncAllForProject(projectId);
          return { success: true, result };
        }

        // ─── Logs ────────────────────────────────────────────────────────
        case 'log_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.logs.findByProject(projectId, {
            level: optionalString(args, 'level'),
            service: optionalString(args, 'service'),
            search: optionalString(args, 'search'),
            startDate: optionalString(args, 'startDate'),
            endDate: optionalString(args, 'endDate'),
            limit: optionalNumber(args, 'limit'),
          });
          return {
            success: true,
            result: items.map((l) => ({
              id: idToString(l._id),
              level: l.level,
              service: l.service,
              area: l.area,
              message: (l.message || '').slice(0, 400),
              createdAt: l.createdAt,
            })),
          };
        }
        case 'log_search': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.logs.findByProject(projectId, {
            search: requireString(args, 'q'),
            level: optionalString(args, 'level'),
            limit: 50,
          });
          return {
            success: true,
            result: items.map((l) => ({
              level: l.level,
              service: l.service,
              snippet: (l.message || '').slice(0, 200),
              createdAt: l.createdAt,
            })),
          };
        }
        case 'log_stats': {
          if (!projectId) return { success: false, error: 'projectId required' };
          return { success: true, result: await this.logs.stats(projectId) };
        }

        // ─── Releases ────────────────────────────────────────────────────
        case 'release_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.releases.findByProject(projectId, {
            status: optionalEnum(args, 'status', Object.values(ReleaseStatus)),
            platform: optionalEnum(args, 'platform', Object.values(ReleasePlatform)),
            releaseType: optionalEnum(args, 'releaseType', Object.values(ReleaseType)),
          });
          return {
            success: true,
            result: items.map((r) => ({
              id: r._id.toString(),
              version: r.version,
              title: r.title,
              status: r.status,
              platform: r.platform,
              releaseType: r.releaseType,
              tags: r.tags,
            })),
          };
        }
        case 'release_get': {
          const r = await this.releases.findById(requireString(args, 'id'));
          return { success: true, result: r.toObject() };
        }
        case 'release_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const r = await this.releases.create({
            projectId,
            version: requireString(args, 'version'),
            title: optionalString(args, 'title'),
            description: optionalString(args, 'description'),
            releaseType: optionalEnum(args, 'releaseType', Object.values(ReleaseType)),
            platform: optionalEnum(args, 'platform', Object.values(ReleasePlatform)),
            status: optionalEnum(args, 'status', Object.values(ReleaseStatus)),
            downloadUrl: optionalString(args, 'downloadUrl'),
            tags: optionalStringArray(args, 'tags'),
          });
          return { success: true, result: { id: r._id.toString(), version: r.version } };
        }
        case 'release_update': {
          const r = await this.releases.update(requireString(args, 'id'), {
            version: optionalString(args, 'version'),
            title: optionalString(args, 'title'),
            description: optionalString(args, 'description'),
            status: optionalEnum(args, 'status', Object.values(ReleaseStatus)),
          });
          return { success: true, result: { id: r._id.toString(), version: r.version } };
        }
        case 'release_sync_gitlab': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const result = await this.releases.syncReleases(
            projectId,
            optionalNumber(args, 'repoIndex'),
          );
          return { success: true, result };
        }

        // ─── Attachments ─────────────────────────────────────────────────
        case 'attachment_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.attachments.findByProject(
            projectId,
            optionalString(args, 'entityType'),
            optionalString(args, 'entityId'),
          );
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          return {
            success: true,
            result: items.slice(0, limit).map((a) => ({
              id: a._id.toString(),
              fileName: a.originalName,
              mimeType: a.mimeType,
              size: a.size,
              entityType: a.entityType,
              entityId: a.entityId?.toString(),
            })),
          };
        }
        case 'attachment_get': {
          const a = await this.attachments.findById(requireString(args, 'id'));
          return {
            success: true,
            result: {
              id: a._id.toString(),
              fileName: a.originalName,
              mimeType: a.mimeType,
              size: a.size,
              tags: a.tags,
              description: a.description,
            },
          };
        }
        case 'attachment_download': {
          const attachmentId = requireString(args, 'id');
          const { text, attachment } = await this.attachments.getText(attachmentId);
          if (text != null) {
            return {
              success: true,
              result: {
                fileName: attachment.originalName,
                mimeType: attachment.mimeType,
                size: attachment.size,
                kind: 'text',
                content: text,
              },
            };
          }
          const { buffer } = await this.attachments.getContent(attachmentId);
          // Cap binary download at ~3MB after base64 expansion to keep prompts sane.
          if (buffer.length > 3 * 1024 * 1024) {
            return { success: false, error: `binary file too large for chat context (${buffer.length} bytes)` };
          }
          return {
            success: true,
            result: {
              fileName: attachment.originalName,
              mimeType: attachment.mimeType,
              size: attachment.size,
              kind: 'binary',
              base64: buffer.toString('base64'),
            },
          };
        }
        case 'attachment_upload': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const a = await this.attachments.createFromBase64(
            {
              projectId,
              fileName: requireString(args, 'fileName'),
              mimeType: optionalString(args, 'mimeType'),
              entityType: optionalString(args, 'entityType'),
              entityId: optionalString(args, 'entityId'),
              description: optionalString(args, 'description'),
              tags: optionalStringArray(args, 'tags'),
            },
            requireString(args, 'content'),
          );
          return { success: true, result: { id: a._id.toString(), fileName: a.originalName, size: a.size } };
        }

        // ─── Workspaces (M-22) ───────────────────────────────────────────
        case 'workspace_list': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const items = await this.workspaces.findByProject(
            projectId,
            optionalEnum(args, 'status', WORKSPACE_STATUSES),
          );
          return {
            success: true,
            result: items.map((w) => ({
              id: w._id.toString(),
              name: w.name,
              status: w.status,
              repoUrl: w.repoUrl,
              branch: w.branch,
              sizeBytes: w.sizeBytes,
              lastActivityAt: w.lastActivityAt,
            })),
          };
        }
        case 'workspace_get': {
          const wsId = optionalString(args, 'id');
          if (wsId) {
            const w = await this.workspaces.findById(wsId);
            return { success: true, result: w.toObject() };
          }
          if (!projectId) return { success: false, error: 'projectId or id required' };
          const w = await this.workspaces.findByName(projectId, requireString(args, 'name'));
          return { success: true, result: w.toObject() };
        }
        case 'workspace_create': {
          if (!projectId) return { success: false, error: 'projectId required' };
          const w = await this.workspaces.create({
            projectId,
            name: requireString(args, 'name'),
            description: optionalString(args, 'description'),
            repoUrl: optionalString(args, 'repoUrl'),
            branch: optionalString(args, 'branch'),
          });
          return { success: true, result: { id: w._id.toString(), name: w.name, path: w.path } };
        }
        case 'workspace_update': {
          const w = await this.workspaces.update(requireString(args, 'id'), {
            name: optionalString(args, 'name'),
            description: optionalString(args, 'description'),
            repoUrl: optionalString(args, 'repoUrl'),
            branch: optionalString(args, 'branch'),
          });
          return { success: true, result: { id: w._id.toString(), name: w.name } };
        }
        case 'workspace_archive': {
          const w = await this.workspaces.archive(requireString(args, 'id'));
          return { success: true, result: { id: w._id.toString(), status: w.status } };
        }
        case 'workspace_delete': {
          // Chat path goes straight through — the user is already in the chat
          // dock and explicitly asked. The MCP path adds an ask_user dialog
          // (see mcp-tools.ts), but here the chat IS the user-interface.
          const wsId = requireString(args, 'id');
          await this.workspaces.remove(wsId);
          return { success: true, result: { deleted: true, id: wsId } };
        }
        case 'workspace_clone': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          const authenticatedUrl = await this.workspaceGitTokens.buildAuthenticatedCloneUrl(
            w,
            requireString(args, 'repoUrl'),
          );
          const sidecar = await this.workspaceClient.clone(
            w._id.toString(),
            authenticatedUrl,
            optionalString(args, 'branch'),
          );
          let sizeBytes: number | undefined;
          try {
            sizeBytes = (await this.workspaceClient.size(w._id.toString())).sizeBytes;
          } catch {
            sizeBytes = undefined;
          }
          await this.workspaces.touch(w._id.toString(), sizeBytes);
          return { success: true, result: { cloned: true, sizeBytes, sidecar } };
        }
        case 'workspace_pull': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          const sidecar = await this.workspaceClient.pull(w._id.toString());
          await this.workspaces.touch(w._id.toString());
          return { success: true, result: { pulled: true, sidecar } };
        }
        case 'workspace_tree': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          const tree = await this.workspaceClient.tree(
            w._id.toString(),
            optionalString(args, 'path'),
            optionalNumber(args, 'depth'),
          );
          await this.workspaces.touch(w._id.toString());
          return { success: true, result: tree };
        }
        case 'workspace_read': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          const file = await this.workspaceClient.read(w._id.toString(), requireString(args, 'path'));
          await this.workspaces.touch(w._id.toString());
          return { success: true, result: file };
        }
        case 'workspace_search': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          const search = await this.workspaceClient.search(
            w._id.toString(),
            requireString(args, 'query'),
            optionalStringArray(args, 'include'),
            optionalStringArray(args, 'exclude'),
          );
          await this.workspaces.touch(w._id.toString());
          return { success: true, result: search };
        }
        case 'workspace_status': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          const status = await this.workspaceClient.status(w._id.toString());
          await this.workspaces.touch(w._id.toString());
          return { success: true, result: status };
        }
        case 'workspace_exec': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          // Nur die Objekt-Form wird geprüft; die Key/Value-Regeln (Keys [A-Z_]…,
          // Werte <=4KB) erzwingt der Sidecar bzw. ExecWorkspaceDto.
          const callerEnv = optionalObject<Record<string, string>>(args, 'env');
          const gitEnv = await this.workspaceGitTokens.resolveForWorkspace(w);
          const dgEnv = this.workspaceCliToken.buildEnvFor(w._id.toString(), w.projectId.toString());
          const mergedEnv = Object.keys(gitEnv).length || Object.keys(dgEnv).length || callerEnv
            ? { ...gitEnv, ...dgEnv, ...(callerEnv ?? {}) }
            : undefined;
          const exec = await this.workspaceClient.exec(
            w._id.toString(),
            requireString(args, 'command'),
            optionalNumber(args, 'timeout'),
            mergedEnv,
          );
          await this.workspaces.touch(w._id.toString());
          return { success: true, result: exec };
        }
        case 'workspace_attachment_save': {
          const w = await this.workspaces.findById(requireString(args, 'id'));
          const path = requireString(args, 'path');
          const file = await this.workspaceClient.readBase64(w._id.toString(), path);
          const fileName = optionalString(args, 'fileName')
            || path.split('/').filter(Boolean).pop()
            || 'file';
          const attachment = await this.attachments.createFromBase64(
            {
              projectId: w.projectId.toString(),
              fileName,
              entityType: optionalString(args, 'entityType'),
              entityId: optionalString(args, 'entityId'),
              description: optionalString(args, 'description'),
              tags: optionalStringArray(args, 'tags'),
            },
            file.contentBase64,
          );
          await this.workspaces.touch(w._id.toString());
          return {
            success: true,
            result: {
              saved: true,
              attachmentId: attachment._id.toString(),
              fileName,
              sizeBytes: file.size,
            },
          };
        }

        case 'customer_list': {
          const items = await this.customers.findAll({
            status: optionalEnum(args, 'status', Object.values(CustomerStatus)),
            tag: optionalString(args, 'tag'),
            q: optionalString(args, 'q'),
            includeArchived: optionalBoolean(args, 'includeArchived'),
            projectId: optionalString(args, 'projectId'),
          });
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          return {
            success: true,
            result: items.slice(0, limit).map((c) => ({
              id: c._id.toString(),
              name: c.name,
              status: c.status,
              tags: c.tags,
            })),
          };
        }
        case 'customer_get': {
          const c = await this.customers.findById(requireString(args, 'id'));
          return {
            success: true,
            result: {
              id: c._id.toString(),
              name: c.name,
              description: c.description,
              status: c.status,
              tags: c.tags,
              primaryContactName: c.primaryContactName,
              primaryContactEmail: c.primaryContactEmail,
              website: c.website,
            },
          };
        }
        case 'customer_project_list': {
          const links = await this.customers.findProjectLinks(requireString(args, 'customerId'));
          return {
            success: true,
            result: links.map((l) => ({
              id: l._id.toString(),
              customerId: l.customerId.toString(),
              projectId: l.projectId.toString(),
              status: l.status,
              role: l.role,
            })),
          };
        }
        case 'project_customer_links': {
          const pid = optionalString(args, 'projectId') || projectId;
          if (!pid) return { success: false, error: 'projectId required' };
          const links = await this.customers.findLinksByProject(pid);
          return {
            success: true,
            result: links.map((l) => ({
              id: l._id.toString(),
              customerId: l.customerId.toString(),
              status: l.status,
              role: l.role,
            })),
          };
        }
        case 'contact_list': {
          const items = await this.contacts.findByCustomer(requireString(args, 'customerId'));
          return {
            success: true,
            result: items.map((c) => ({
              id: c._id.toString(),
              customerId: c.customerId.toString(),
              name: c.name,
              role: c.role,
              email: c.email,
              isPrimary: c.isPrimary,
            })),
          };
        }
        case 'contact_get': {
          const c = await this.contacts.findById(requireString(args, 'id'));
          return {
            success: true,
            result: {
              id: c._id.toString(),
              // `?.` bleibt bewusst stehen: `customerId` ist im Schema required,
              // aber das Laufzeitverhalten dieses Tools soll sich hier nicht ändern.
              customerId: c.customerId?.toString(),
              name: c.name,
              role: c.role,
              email: c.email,
              phone: c.phone,
              notes: c.notes,
              isPrimary: c.isPrimary,
            },
          };
        }

        // ─── Stacks ─────────────────────────────────────────────────────
        case 'stack_list':
          return { success: true, result: await this.stacksService.findAll() };
        case 'stack_get':
          return { success: true, result: await this.stacksService.findById(requireString(args, 'id')) };
        case 'stack_export_markdown':
          return {
            success: true,
            result: await this.stacksService.exportAsMarkdown(
              requireString(args, 'id'),
              optionalString(args, 'entryId'),
            ),
          };
        case 'stack_create':
          return {
            success: true,
            result: await this.stacksService.create({
              name: requireString(args, 'name'),
              description: optionalString(args, 'description'),
            }),
          };
        case 'stack_update':
          return {
            success: true,
            result: await this.stacksService.update(requireString(args, 'id'), {
              name: optionalString(args, 'name'),
              description: optionalString(args, 'description'),
            }),
          };
        case 'stack_entry_add':
          return {
            success: true,
            result: await this.stacksService.addEntry(requireString(args, 'id'), {
              title: requireString(args, 'title'),
              content: optionalString(args, 'content'),
            }),
          };
        case 'stack_entry_update':
          return {
            success: true,
            result: await this.stacksService.updateEntry(
              requireString(args, 'id'),
              requireString(args, 'entryId'),
              {
                title: optionalString(args, 'title'),
                content: optionalString(args, 'content'),
                order: optionalNumber(args, 'order'),
              },
            ),
          };
        case 'stack_entry_remove':
          return {
            success: true,
            result: await this.stacksService.removeEntry(
              requireString(args, 'id'),
              requireString(args, 'entryId'),
            ),
          };

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
