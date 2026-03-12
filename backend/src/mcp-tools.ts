import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ProjectsService } from './projects/projects.service';
import { TodosService } from './todos/todos.service';
import { SessionsService } from './sessions/sessions.service';
import { KnowledgeService } from './knowledge/knowledge.service';
import { ChangelogService } from './changelog/changelog.service';
import { MilestonesService } from './milestones/milestones.service';
import { ActivitiesService } from './activities/activities.service';
import { PushService } from './push/push.service';
import { EnvironmentsService } from './environments/environments.service';
import { SecretsService } from './secrets/secrets.service';
import { ManualsService } from './manuals/manuals.service';
import { ResearchService } from './research/research.service';
import { SettingsService } from './settings/settings.service';
import { NotificationsService } from './notifications/notifications.service';
import { SchemasService } from './schemas/schemas.service';
import { DependenciesService } from './dependencies/dependencies.service';
import { FeaturesService } from './features/features.service';
import { AGENT_INSTRUCTIONS_KEY, DEFAULT_AGENT_INSTRUCTIONS } from './settings/default-agent-instructions';

function requireString(args: Record<string, unknown>, field: string): string {
  const val = args[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Missing required field: ${field}`);
  }
  return val;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new Error(`${field} must be a string`);
  return val;
}

function optionalStringArray(args: Record<string, unknown>, field: string): string[] | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  // Accept a single string: split by comma if it contains commas, otherwise wrap in array
  if (typeof val === 'string') {
    return val.includes(',') ? val.split(',').map((s) => s.trim()).filter(Boolean) : [val];
  }
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return val;
}

function optionalBoolean(args: Record<string, unknown>, field: string): boolean | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new Error(`${field} must be a boolean`);
  return val;
}

function optionalNumber(args: Record<string, unknown>, field: string): number | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') throw new Error(`${field} must be a number`);
  return val;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function compactList<T extends Record<string, unknown>>(items: T[], stripFields: string[]): Record<string, unknown>[] {
  return items.map((item) => {
    const obj = typeof item.toJSON === 'function' ? (item as any).toJSON() : { ...item };
    for (const f of stripFields) delete obj[f];
    return obj;
  });
}

function snippet(text: string | undefined, maxLen = 200): string | undefined {
  if (!text) return undefined;
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

function applyPagination<T>(items: T[], limit?: number, offset?: number): T[] {
  const start = offset || 0;
  const end = limit ? start + limit : undefined;
  return items.slice(start, end);
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function compactUpdateResult(doc: any): Record<string, unknown> {
  const obj = typeof doc.toJSON === 'function' ? doc.toJSON() : { ...doc };
  return { updated: true, _id: obj._id, updatedAt: obj.updatedAt };
}

function compactCreateResult(doc: any, extra?: Record<string, unknown>): Record<string, unknown> {
  const obj = typeof doc.toJSON === 'function' ? doc.toJSON() : { ...doc };
  return { created: true, _id: obj._id, createdAt: obj.createdAt, ...extra };
}

export interface McpServices {
  projectsService: ProjectsService;
  todosService: TodosService;
  sessionsService: SessionsService;
  knowledgeService: KnowledgeService;
  changelogService: ChangelogService;
  milestonesService: MilestonesService;
  activitiesService: ActivitiesService;
  pushService: PushService;
  environmentsService: EnvironmentsService;
  secretsService: SecretsService;
  manualsService: ManualsService;
  researchService: ResearchService;
  settingsService: SettingsService;
  notificationsService: NotificationsService;
  schemasService: SchemasService;
  dependenciesService: DependenciesService;
  featuresService: FeaturesService;
}

const tools = [
  {
    name: 'project_create',
    description: 'Create a new project to track',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique project name' },
        path: { type: 'string', description: 'Filesystem path to the project' },
        description: { type: 'string', description: 'Project description' },
        techStack: { type: 'array', items: { type: 'string' }, description: 'Technologies used' },
        repository: { type: 'string', description: 'Git repository URL' },
        instructions: { type: 'string', description: 'Instructions for Claude on how to work with this project' },
        components: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'version'] }, description: 'Monorepo components with versions (e.g. API v1.2, Frontend v2.0)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'project_list',
    description: 'List all tracked projects (compact: id, name, path, techStack, active). Use project_get for full details including instructions and components.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        active: { type: 'boolean', description: 'Filter by active status' },
      },
    },
  },
  {
    name: 'project_get',
    description: 'Get a project by ID or name',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Project name' },
      },
    },
  },
  {
    name: 'project_update',
    description: 'Update a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string' },
        path: { type: 'string' },
        description: { type: 'string' },
        techStack: { type: 'array', items: { type: 'string' } },
        repository: { type: 'string' },
        active: { type: 'boolean' },
        instructions: { type: 'string', description: 'Instructions for Claude on how to work with this project' },
        components: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'version'] }, description: 'Monorepo components with versions' },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_delete',
    description: 'Delete a project and all associated data',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Project MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_create',
    description: 'Create a new todo/task for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        title: { type: 'string', description: 'Todo title' },
        description: { type: 'string', description: 'Detailed description' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        milestoneId: { type: 'string', description: 'Milestone MongoDB ID to associate with' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Array of Todo MongoDB IDs that block this todo' },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'todo_list',
    description: 'List todos (compact: id, title, status, priority, tags, milestoneId). Archived todos are excluded by default. Use todo_get for full details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'], description: 'Filter by status' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Filter by priority' },
        milestoneId: { type: 'string', description: 'Filter by milestone ID' },
        tag: { type: 'string', description: 'Filter by tag (exact match)' },
        includeArchived: { type: 'boolean', description: 'Include archived todos (default false)' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
    },
  },
  {
    name: 'todo_get',
    description: 'Get a single todo with full details (description, comments, blockedBy). Provide either id OR number+projectId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
        number: { type: 'string', description: 'Todo number (e.g. "3" or "T-3") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
      },
    },
  },
  {
    name: 'todo_update',
    description: 'Update a todo (e.g. change status, priority). IMPORTANT: Status transitions must follow the order open -> in_progress -> review -> done (one step at a time, forward or backward). Skipping steps will be rejected. Provide either id OR number+projectId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
        number: { type: 'string', description: 'Todo number (e.g. "3" or "T-3") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        milestoneId: { type: 'string', description: 'Milestone MongoDB ID to associate with' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Array of Todo MongoDB IDs that block this todo' },
        archived: { type: 'boolean', description: 'Archive or unarchive a todo' },
      },
    },
  },
  {
    name: 'todo_delete',
    description: 'Delete a todo. Provide either id OR number+projectId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
        number: { type: 'string', description: 'Todo number (e.g. "3" or "T-3") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
      },
    },
  },
  {
    name: 'todo_comment',
    description: 'Add a comment to a todo. Provide either id OR number+projectId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
        number: { type: 'string', description: 'Todo number (e.g. "3" or "T-3") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
        text: { type: 'string', description: 'Comment text' },
        author: { type: 'string', description: 'Comment author (default: claude)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'session_save',
    description: 'Save a work session summary for a project (what was done, next steps, open questions)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        summary: { type: 'string', description: 'What was accomplished in this session' },
        filesChanged: { type: 'array', items: { type: 'string' }, description: 'Files that were modified' },
        nextSteps: { type: 'array', items: { type: 'string' }, description: 'What should be done next' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Unresolved questions' },
      },
      required: ['projectId', 'summary'],
    },
  },
  {
    name: 'session_get',
    description: 'Get the latest work session(s) for a project. limit=1 (default): full details. limit>1: compact list (date, summary snippet).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        limit: { type: 'number', description: 'Number of sessions to return (default 1)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'knowledge_save',
    description: 'Save a knowledge entry (architecture decisions, patterns, conventions, notes) for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        topic: { type: 'string', description: 'Topic/title of the knowledge entry' },
        content: { type: 'string', description: 'The knowledge content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        category: { type: 'string', description: 'Category for grouping (e.g. Architecture, Patterns, Conventions)' },
      },
      required: ['projectId', 'topic', 'content'],
    },
  },
  {
    name: 'knowledge_search',
    description: 'Search knowledge base (returns compact results with content snippet). Use knowledge_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        projectId: { type: 'string', description: 'Scope search to a specific project' },
        limit: { type: 'number', description: 'Max items to return' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_list',
    description: 'List knowledge entries (compact: id, topic, tags, category). Use knowledge_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        category: { type: 'string', description: 'Filter by category' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'knowledge_get',
    description: 'Get a single knowledge entry with full content',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Knowledge entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_update',
    description: 'Update a knowledge entry',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Knowledge entry MongoDB ID' },
        topic: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string', description: 'Category for grouping' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_delete',
    description: 'Delete a knowledge entry',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Knowledge entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'changelog_add',
    description: 'Add a changelog entry for a project (version, changes, component)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        version: { type: 'string', description: 'Version number (e.g. 1.2.0)' },
        changes: { type: 'array', items: { type: 'string' }, description: 'List of changes made' },
        summary: { type: 'string', description: 'Brief summary of the release/changes' },
        component: { type: 'string', description: 'Component name for monorepos (e.g. API, Frontend)' },
      },
      required: ['projectId', 'changes'],
    },
  },
  {
    name: 'changelog_list',
    description: 'List changelog entries (compact: id, version, summary, component, date). Default limit 10. Use changelog_get for full changes list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        limit: { type: 'number', description: 'Number of entries to return (default 10)' },
        offset: { type: 'number', description: 'Skip first N entries' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'changelog_get',
    description: 'Get a single changelog entry with full changes list',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Changelog entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'changelog_update',
    description: 'Update a changelog entry (version, changes, summary, component)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Changelog entry MongoDB ID' },
        version: { type: 'string', description: 'Version number' },
        changes: { type: 'array', items: { type: 'string' }, description: 'List of changes' },
        summary: { type: 'string', description: 'Brief summary' },
        component: { type: 'string', description: 'Component name for monorepos' },
      },
      required: ['id'],
    },
  },
  {
    name: 'changelog_delete',
    description: 'Delete a changelog entry',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Changelog entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'milestone_create',
    description: 'Create a milestone (feature/epic) for a project. Use milestones to group related todos together.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Milestone name' },
        description: { type: 'string', description: 'Milestone description' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        dueDate: { type: 'string', description: 'Due date (ISO 8601)' },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: 'milestone_list',
    description: 'List milestones for a project. Archived milestones are excluded by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'], description: 'Filter by status' },
        includeArchived: { type: 'boolean', description: 'Include archived milestones (default: false)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'milestone_get',
    description: 'Get a milestone by ID or number. Provide either id OR number+projectId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Milestone MongoDB ID' },
        number: { type: 'string', description: 'Milestone number (e.g. "1" or "M-1") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
      },
    },
  },
  {
    name: 'milestone_update',
    description: 'Update a milestone. IMPORTANT: Setting status to "done" REQUIRES a changelogId — first create a changelog entry via changelog_add, then pass its ID here. The changelog must not already be assigned to another milestone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Milestone MongoDB ID' },
        number: { type: 'string', description: 'Milestone number (e.g. "1" or "M-1") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        dueDate: { type: 'string', description: 'Due date (ISO 8601)' },
        archived: { type: 'boolean', description: 'Archive or unarchive a milestone' },
        changelogId: { type: 'string', description: 'Changelog MongoDB ID (REQUIRED when setting status to done)' },
      },
    },
  },
  {
    name: 'milestone_delete',
    description: 'Delete a milestone. Provide either id OR number+projectId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Milestone MongoDB ID' },
        number: { type: 'string', description: 'Milestone number (e.g. "1" or "M-1") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
      },
    },
  },
  {
    name: 'notify_user',
    description: 'Send a push notification to the user via the DevGrimoire PWA. Use this to inform the user about completed tasks, important updates, or when you need their attention.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body text' },
        url: { type: 'string', description: 'URL to open when notification is clicked (e.g. /projects/abc123)' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'environment_create',
    description: 'Create a project environment (e.g. dev, staging, prod) with key-value variables',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Environment name (e.g. dev, staging, prod)' },
        variables: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] }, description: 'Key-value pairs for environment variables' },
        active: { type: 'boolean', description: 'Whether environment is active (default true)' },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: 'environment_list',
    description: 'List all environments for a project (compact: name, active, variableCount). Use environment_get for full variables.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'environment_get',
    description: 'Get a single environment with all its variables',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Environment MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'environment_update',
    description: 'Update an environment (name, variables, active status)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Environment MongoDB ID' },
        name: { type: 'string' },
        variables: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
        active: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'environment_delete',
    description: 'Delete an environment',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Environment MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'secret_set',
    description: 'Create or update an encrypted secret for a project. Secrets are stored with AES-256-GCM encryption. Use environmentId to scope to a specific environment, or omit for project-global secrets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        environmentId: { type: 'string', description: 'Environment MongoDB ID (optional, omit for project-global)' },
        key: { type: 'string', description: 'Secret name (e.g. DB_PASSWORD, API_KEY)' },
        value: { type: 'string', description: 'Secret value (will be encrypted)' },
        description: { type: 'string', description: 'Optional description of the secret' },
      },
      required: ['projectId', 'key', 'value'],
    },
  },
  {
    name: 'secret_get',
    description: 'Get a single secret with its decrypted value',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Secret MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'secret_list',
    description: 'List secrets for a project (keys and descriptions only, NO values). Use secret_get to retrieve individual values.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        environmentId: { type: 'string', description: 'Filter by environment ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'secret_delete',
    description: 'Delete a secret',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Secret MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'environment_export',
    description: 'Export all variables and decrypted secrets of an environment as key=value pairs (useful for .env file generation)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        environmentId: { type: 'string', description: 'Environment MongoDB ID' },
        includeGlobalSecrets: { type: 'boolean', description: 'Include project-global secrets (default true)' },
      },
      required: ['projectId', 'environmentId'],
    },
  },
  {
    name: 'manual_create',
    description: 'Create a new manual entry for a project. Manuals are categorized documentation pages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        title: { type: 'string', description: 'Entry title' },
        content: { type: 'string', description: 'Content in Markdown format' },
        category: { type: 'string', description: 'Category for grouping (e.g. Setup, API, Deployment)' },
        sortOrder: { type: 'number', description: 'Sort order within category (default 0)' },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'manual_list',
    description: 'List manual entries for a project (compact: id, title, category, sortOrder, updatedAt). Use manual_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        category: { type: 'string', description: 'Filter by category' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'manual_get',
    description: 'Get a single manual entry with full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Manual entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'manual_update',
    description: 'Update a manual entry (title, content, category, sortOrder).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Manual entry MongoDB ID' },
        title: { type: 'string' },
        content: { type: 'string' },
        category: { type: 'string' },
        sortOrder: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'manual_delete',
    description: 'Delete a manual entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Manual entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_save',
    description: 'Save a research entry (findings, analysis, comparisons) for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        title: { type: 'string', description: 'Research title' },
        content: { type: 'string', description: 'Research content/findings' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Source URLs or references' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['projectId', 'title', 'content'],
    },
  },
  {
    name: 'research_search',
    description: 'Search research entries (returns compact results with content snippet). Use research_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        projectId: { type: 'string', description: 'Scope search to a specific project' },
        limit: { type: 'number', description: 'Max items to return' },
      },
      required: ['query'],
    },
  },
  {
    name: 'research_list',
    description: 'List research entries (compact: id, title, tags, sourceCount). Use research_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'research_get',
    description: 'Get a research entry by ID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Research entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_update',
    description: 'Update a research entry',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Research entry MongoDB ID' },
        title: { type: 'string' },
        content: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_delete',
    description: 'Delete a research entry',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Research entry MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'system_instructions_get',
    description: 'IMPORTANT: Call this tool at the start of every session to learn how to work with DevGrimoire correctly. Returns global agent instructions and optionally project-specific instructions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Optional project ID to include project-specific instructions alongside global ones' },
      },
    },
  },
  {
    name: 'system_instructions_set',
    description: 'Update the global agent instructions. Use this when the user asks you to change how agents should behave.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        instructions: { type: 'string', description: 'New global agent instructions in Markdown format' },
      },
      required: ['instructions'],
    },
  },
  {
    name: 'schema_create',
    description: 'Create a database schema object to document a table/collection. Supports mssql, mysql, mongodb, postgresql.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Table/collection name' },
        dbType: { type: 'string', enum: ['mssql', 'mysql', 'mongodb', 'postgresql'], description: 'Database type' },
        database: { type: 'string', description: 'Database name' },
        description: { type: 'string', description: 'Purpose/description of the table' },
        fields: {
          type: 'array',
          description: 'Field definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              nullable: { type: 'boolean' },
              defaultValue: { type: 'string' },
              description: { type: 'string' },
              isPrimaryKey: { type: 'boolean' },
              isIndexed: { type: 'boolean' },
              reference: { type: 'string', description: 'Foreign key reference (e.g. "users.id")' },
            },
            required: ['name', 'type'],
          },
        },
        indexes: {
          type: 'array',
          description: 'Index definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              fields: { type: 'array', items: { type: 'string' } },
              unique: { type: 'boolean' },
              type: { type: 'string', description: 'Index type (e.g. btree, hash, gin, fulltext)' },
            },
            required: ['name', 'fields'],
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['projectId', 'name', 'dbType'],
    },
  },
  {
    name: 'schema_list',
    description: 'List database schema objects for a project. Returns compact list without fields/indexes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        dbType: { type: 'string', enum: ['mssql', 'mysql', 'mongodb', 'postgresql'], description: 'Filter by database type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (all must match)' },
        limit: { type: 'number', description: 'Max results' },
        offset: { type: 'number', description: 'Skip results' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'schema_get',
    description: 'Get a database schema object by ID with full details (fields, indexes).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Schema MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'schema_update',
    description: 'Update a database schema object. Automatically creates a version snapshot before applying changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Schema MongoDB ID' },
        name: { type: 'string' },
        dbType: { type: 'string', enum: ['mssql', 'mysql', 'mongodb', 'postgresql'] },
        database: { type: 'string' },
        description: { type: 'string' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              nullable: { type: 'boolean' },
              defaultValue: { type: 'string' },
              description: { type: 'string' },
              isPrimaryKey: { type: 'boolean' },
              isIndexed: { type: 'boolean' },
              reference: { type: 'string' },
            },
            required: ['name', 'type'],
          },
        },
        indexes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              fields: { type: 'array', items: { type: 'string' } },
              unique: { type: 'boolean' },
              type: { type: 'string' },
            },
            required: ['name', 'fields'],
          },
        },
        tags: { type: 'array', items: { type: 'string' } },
        changeNote: { type: 'string', description: 'Description of what changed (stored in version history)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'schema_delete',
    description: 'Delete a database schema object and all its version history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Schema MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'schema_versions',
    description: 'Get version history of a database schema object. Without version: compact list (version, changeNote, date). With version number: full details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        schemaId: { type: 'string', description: 'Schema MongoDB ID' },
        version: { type: 'number', description: 'Specific version number (omit for all versions)' },
      },
      required: ['schemaId'],
    },
  },
  {
    name: 'dependency_add',
    description: 'Add a project dependency (npm, composer, pip, cargo, go, maven, nuget, gem) with version and description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Package name' },
        version: { type: 'string', description: 'Package version' },
        packageManager: { type: 'string', enum: ['npm', 'composer', 'pip', 'cargo', 'go', 'maven', 'nuget', 'gem'], description: 'Package manager type' },
        description: { type: 'string', description: 'What this package is used for' },
        devDependency: { type: 'boolean', description: 'Whether this is a dev dependency (default false)' },
        category: { type: 'string', description: 'Category (e.g. Database, Auth, UI, Testing)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['projectId', 'name', 'version', 'packageManager'],
    },
  },
  {
    name: 'dependency_list',
    description: 'List project dependencies (compact: name, version, packageManager, devDependency, category). Use dependency_get for full details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        packageManager: { type: 'string', enum: ['npm', 'composer', 'pip', 'cargo', 'go', 'maven', 'nuget', 'gem'], description: 'Filter by package manager' },
        category: { type: 'string', description: 'Filter by category' },
        devDependency: { type: 'boolean', description: 'Filter by dev/prod dependency' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'dependency_get',
    description: 'Get a single dependency with full details including description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Dependency MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'dependency_update',
    description: 'Update a dependency (version, description, category, tags).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Dependency MongoDB ID' },
        name: { type: 'string' },
        version: { type: 'string' },
        description: { type: 'string' },
        packageManager: { type: 'string', enum: ['npm', 'composer', 'pip', 'cargo', 'go', 'maven', 'nuget', 'gem'] },
        devDependency: { type: 'boolean' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'dependency_delete',
    description: 'Delete a dependency.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Dependency MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'dependency_scan',
    description: 'Bulk-import dependencies from a package file. The agent reads the file (package.json, composer.json, etc.) and passes all dependencies here. Upsert behavior: new packages are created, existing ones get their version updated. Existing descriptions/categories/tags are preserved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        packageManager: { type: 'string', enum: ['npm', 'composer', 'pip', 'cargo', 'go', 'maven', 'nuget', 'gem'], description: 'Package manager type' },
        dependencies: {
          type: 'array',
          description: 'Array of dependencies to import',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Package name' },
              version: { type: 'string', description: 'Package version' },
              devDependency: { type: 'boolean', description: 'Dev dependency flag' },
            },
            required: ['name', 'version'],
          },
        },
      },
      required: ['projectId', 'packageManager', 'dependencies'],
    },
  },
  // ── Feature tools ──
  {
    name: 'feature_create',
    description: 'Create a project feature entry to document what the project offers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Feature name' },
        description: { type: 'string', description: 'Feature description (Markdown)' },
        category: { type: 'string', description: 'Category (e.g. Auth, API, UI)' },
        status: { type: 'string', enum: ['planned', 'in_development', 'released', 'deprecated'], description: 'Feature status (default: planned)' },
        version: { type: 'string', description: 'Version when feature was added/released' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Feature priority' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: 'feature_list',
    description: 'List project features (compact: name, status, category, priority, version). Use feature_get for full details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        status: { type: 'string', enum: ['planned', 'in_development', 'released', 'deprecated'], description: 'Filter by status' },
        category: { type: 'string', description: 'Filter by category' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'feature_get',
    description: 'Get a single feature with full details including description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Feature MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'feature_update',
    description: 'Update a feature (name, description, status, category, version, priority, tags).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Feature MongoDB ID' },
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
  {
    name: 'feature_delete',
    description: 'Delete a feature.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Feature MongoDB ID' },
      },
      required: ['id'],
    },
  },
];

export function registerMcpTools(server: Server, services: McpServices): void {
  const { projectsService, todosService, sessionsService, knowledgeService, changelogService, milestonesService, activitiesService, pushService, environmentsService, secretsService, manualsService, researchService, settingsService, notificationsService, schemasService, dependenciesService, featuresService } = services;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case 'project_create': {
          const proj = await projectsService.create({
            name: requireString(a, 'name'),
            path: optionalString(a, 'path'),
            description: optionalString(a, 'description'),
            techStack: optionalStringArray(a, 'techStack'),
            repository: optionalString(a, 'repository'),
            instructions: optionalString(a, 'instructions'),
            components: a.components as any,
          });
          result = compactCreateResult(proj, { name: (proj as any).name });
          break;
        }
        case 'project_list': {
          const projects = await projectsService.findAll(optionalBoolean(a, 'active'), optionalBoolean(a, 'favorite'));
          result = compactList(projects as any, ['instructions', 'components', '__v']);
          break;
        }
        case 'project_get': {
          const id = optionalString(a, 'id');
          const pName = optionalString(a, 'name');
          if (id) {
            result = await projectsService.findById(id);
          } else if (pName) {
            result = await projectsService.findByName(pName);
          } else {
            return errorResult('Provide either id or name');
          }
          if (!result) return textResult({ message: 'Project not found' });
          break;
        }
        case 'project_update':
          result = compactUpdateResult(await projectsService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            path: optionalString(a, 'path'),
            description: optionalString(a, 'description'),
            techStack: optionalStringArray(a, 'techStack'),
            repository: optionalString(a, 'repository'),
            active: optionalBoolean(a, 'active'),
            instructions: optionalString(a, 'instructions'),
            components: a.components as any,
          }));
          break;
        case 'project_delete': {
          const id = requireString(a, 'id');
          await projectsService.remove(id);
          await Promise.all([
            todosService.removeByProject(id),
            sessionsService.removeByProject(id),
            knowledgeService.removeByProject(id),
            changelogService.removeByProject(id),
            milestonesService.removeByProject(id),
            activitiesService.removeByProject(id),
            environmentsService.removeByProject(id),
            secretsService.removeByProject(id),
            manualsService.removeByProject(id),
            researchService.removeByProject(id),
            schemasService.removeByProject(id),
            dependenciesService.removeByProject(id),
            featuresService.removeByProject(id),
          ]);
          result = { deleted: true, id };
          break;
        }
        case 'todo_create': {
          const todo = await todosService.create({
            projectId: requireString(a, 'projectId'),
            title: requireString(a, 'title'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            priority: optionalString(a, 'priority') as any,
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            blockedBy: optionalStringArray(a, 'blockedBy'),
          });
          result = compactCreateResult(todo, { displayNumber: (todo as any).displayNumber, title: (todo as any).title });
          break;
        }
        case 'todo_list': {
          const todos = await todosService.findAll({
            projectId: optionalString(a, 'projectId'),
            status: optionalString(a, 'status') as any,
            priority: optionalString(a, 'priority'),
            milestoneId: optionalString(a, 'milestoneId'),
            tag: optionalString(a, 'tag'),
            includeArchived: optionalBoolean(a, 'includeArchived'),
          });
          const compactTodos = compactList(todos as any, ['description', 'comments', 'blockedBy', '__v']);
          const todoLimit = optionalNumber(a, 'limit') ?? (optionalString(a, 'projectId') ? undefined : 50);
          result = applyPagination(compactTodos, todoLimit, optionalNumber(a, 'offset'));
          break;
        }
        case 'todo_get': {
          const todoId = await todosService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          result = await todosService.findById(todoId);
          break;
        }
        case 'todo_update': {
          const todoUpdateId = await todosService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          result = compactUpdateResult(await todosService.update(todoUpdateId, {
            title: optionalString(a, 'title'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            priority: optionalString(a, 'priority') as any,
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            blockedBy: optionalStringArray(a, 'blockedBy'),
            archived: optionalBoolean(a, 'archived'),
          }));
          break;
        }
        case 'todo_delete': {
          const todoDelId = await todosService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          await todosService.remove(todoDelId);
          result = { deleted: true, id: todoDelId };
          break;
        }
        case 'todo_comment': {
          const todoCommentId = await todosService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          result = await todosService.addComment(
            todoCommentId,
            requireString(a, 'text'),
            optionalString(a, 'author') || 'claude',
          );
          break;
        }
        case 'session_save': {
          const session = await sessionsService.create({
            projectId: requireString(a, 'projectId'),
            summary: requireString(a, 'summary'),
            filesChanged: optionalStringArray(a, 'filesChanged'),
            nextSteps: optionalStringArray(a, 'nextSteps'),
            openQuestions: optionalStringArray(a, 'openQuestions'),
          });
          result = compactCreateResult(session);
          break;
        }
        case 'session_get': {
          const projectId = requireString(a, 'projectId');
          const limit = optionalNumber(a, 'limit') || 1;
          if (limit > 1) {
            const sessions = await sessionsService.findByProject(projectId, limit);
            result = (sessions as any[]).map((s: any) => {
              const obj = typeof s.toJSON === 'function' ? s.toJSON() : { ...s };
              return {
                _id: obj._id,
                projectId: obj.projectId,
                summary: snippet(obj.summary),
                createdAt: obj.createdAt,
              };
            });
          } else {
            result = await sessionsService.findLatest(projectId);
            if (!result) return textResult({ message: 'No sessions found for this project.' });
          }
          break;
        }
        case 'knowledge_save': {
          const kEntry = await knowledgeService.create({
            projectId: requireString(a, 'projectId'),
            topic: requireString(a, 'topic'),
            content: requireString(a, 'content'),
            tags: optionalStringArray(a, 'tags'),
            category: optionalString(a, 'category'),
          });
          result = compactCreateResult(kEntry, { topic: (kEntry as any).topic });
          break;
        }
        case 'knowledge_search': {
          const kProjectId = optionalString(a, 'projectId');
          const searchResults = await knowledgeService.search(
            requireString(a, 'query'),
            kProjectId,
          );
          const limited = searchResults.slice(0, optionalNumber(a, 'limit') || 10);
          result = limited.map((item: any) => {
            const obj = typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
            if (kProjectId) {
              // Project-scoped: return snippet
              obj.content = snippet(obj.content);
            } else {
              // Global search: only return compact metadata
              delete obj.content;
            }
            delete obj.__v;
            return obj;
          });
          break;
        }
        case 'knowledge_list': {
          const entries = await knowledgeService.findByProject(
            requireString(a, 'projectId'),
            optionalString(a, 'category'),
          );
          const compactEntries = compactList(entries as any, ['content', '__v']);
          result = applyPagination(compactEntries, optionalNumber(a, 'limit'), optionalNumber(a, 'offset'));
          break;
        }
        case 'knowledge_get':
          result = await knowledgeService.findById(requireString(a, 'id'));
          break;
        case 'knowledge_update':
          result = compactUpdateResult(await knowledgeService.update(requireString(a, 'id'), {
            topic: optionalString(a, 'topic'),
            content: optionalString(a, 'content'),
            tags: optionalStringArray(a, 'tags'),
            category: optionalString(a, 'category'),
          }));
          break;
        case 'knowledge_delete':
          await knowledgeService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'changelog_add': {
          const clEntry = await changelogService.create({
            projectId: requireString(a, 'projectId'),
            version: optionalString(a, 'version'),
            changes: a.changes as string[],
            summary: optionalString(a, 'summary'),
            component: optionalString(a, 'component'),
          });
          result = compactCreateResult(clEntry, { version: (clEntry as any).version });
          break;
        }
        case 'changelog_list': {
          const clLimit = optionalNumber(a, 'limit') || 10;
          const changelogs = await changelogService.findByProject(
            requireString(a, 'projectId'),
            clLimit + (optionalNumber(a, 'offset') || 0),
          );
          const compactChangelogs = compactList(changelogs as any, ['changes', '__v']);
          result = applyPagination(compactChangelogs, clLimit, optionalNumber(a, 'offset'));
          break;
        }
        case 'changelog_get':
          result = await changelogService.findById(requireString(a, 'id'));
          break;
        case 'changelog_update':
          result = compactUpdateResult(await changelogService.update(requireString(a, 'id'), {
            version: optionalString(a, 'version'),
            changes: optionalStringArray(a, 'changes'),
            summary: optionalString(a, 'summary'),
            component: optionalString(a, 'component'),
          }));
          break;
        case 'changelog_delete':
          await changelogService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'milestone_create': {
          const ms = await milestonesService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            dueDate: optionalString(a, 'dueDate'),
          });
          result = compactCreateResult(ms, { displayNumber: (ms as any).displayNumber, name: (ms as any).name });
          break;
        }
        case 'milestone_list': {
          const milestones = await milestonesService.findByProject(
            requireString(a, 'projectId'),
            optionalString(a, 'status') as any,
            optionalBoolean(a, 'includeArchived'),
          );
          result = compactList(milestones as any, ['description', '__v']);
          break;
        }
        case 'milestone_get': {
          const msGetId = await milestonesService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          result = await milestonesService.findById(msGetId);
          break;
        }
        case 'milestone_update': {
          const msUpdateId = await milestonesService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          result = compactUpdateResult(await milestonesService.update(msUpdateId, {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            dueDate: optionalString(a, 'dueDate'),
            archived: optionalBoolean(a, 'archived'),
            changelogId: optionalString(a, 'changelogId'),
          }));
          break;
        }
        case 'milestone_delete': {
          const msDelId = await milestonesService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          await milestonesService.remove(msDelId);
          result = { deleted: true, id: msDelId };
          break;
        }
        case 'notify_user': {
          const nTitle = requireString(a, 'title');
          const nBody = requireString(a, 'body');
          const nUrl = optionalString(a, 'url');
          const notification = await notificationsService.create(nTitle, nBody, nUrl);
          const pushResult = await pushService.sendNotification(nTitle, nBody, nUrl);
          result = { notificationId: notification._id.toString(), push: pushResult };
          break;
        }
        case 'environment_create': {
          const env = await environmentsService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            variables: a.variables as any,
            active: optionalBoolean(a, 'active'),
          });
          result = compactCreateResult(env, { name: (env as any).name });
          break;
        }
        case 'environment_list': {
          const envs = await environmentsService.findByProject(requireString(a, 'projectId'));
          result = (envs as any[]).map((e: any) => {
            const obj = typeof e.toJSON === 'function' ? e.toJSON() : { ...e };
            return {
              _id: obj._id,
              projectId: obj.projectId,
              name: obj.name,
              active: obj.active,
              variableCount: (obj.variables || []).length,
              createdAt: obj.createdAt,
              updatedAt: obj.updatedAt,
            };
          });
          break;
        }
        case 'environment_get':
          result = await environmentsService.findById(requireString(a, 'id'));
          break;
        case 'environment_update':
          result = compactUpdateResult(await environmentsService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            variables: a.variables as any,
            active: optionalBoolean(a, 'active'),
          }));
          break;
        case 'environment_delete':
          await environmentsService.delete(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'secret_set': {
          const secret = await secretsService.create({
            projectId: requireString(a, 'projectId'),
            environmentId: optionalString(a, 'environmentId'),
            key: requireString(a, 'key'),
            value: requireString(a, 'value'),
            description: optionalString(a, 'description'),
          });
          result = compactCreateResult(secret, { key: (secret as any).key });
          break;
        }
        case 'secret_get':
          result = await secretsService.findById(requireString(a, 'id'));
          break;
        case 'secret_list':
          result = await secretsService.findByProject(
            requireString(a, 'projectId'),
            optionalString(a, 'environmentId'),
          );
          break;
        case 'secret_delete':
          await secretsService.delete(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'environment_export': {
          const projectId = requireString(a, 'projectId');
          const envId = requireString(a, 'environmentId');
          const includeGlobal = optionalBoolean(a, 'includeGlobalSecrets') !== false;
          const env = await environmentsService.findById(envId);
          const envSecrets = await secretsService.getDecryptedForEnvironment(projectId, envId);
          const globalSecrets = includeGlobal
            ? await secretsService.getDecryptedForEnvironment(projectId, '')
            : [];
          const lines: string[] = [];
          lines.push(`# Environment: ${env.name}`);
          for (const v of env.variables) lines.push(`${v.key}=${v.value}`);
          if (globalSecrets.length > 0) {
            lines.push('# Global Secrets');
            for (const s of globalSecrets) lines.push(`${s.key}=${s.value}`);
          }
          if (envSecrets.length > 0) {
            lines.push(`# ${env.name} Secrets`);
            for (const s of envSecrets) lines.push(`${s.key}=${s.value}`);
          }
          result = { environment: env.name, export: lines.join('\n') };
          break;
        }
        case 'manual_create': {
          const manual = await manualsService.create({
            projectId: requireString(a, 'projectId'),
            title: requireString(a, 'title'),
            content: optionalString(a, 'content'),
            category: optionalString(a, 'category'),
            sortOrder: optionalNumber(a, 'sortOrder'),
          });
          result = compactCreateResult(manual, { title: (manual as any).title });
          break;
        }
        case 'manual_list': {
          const manuals = await manualsService.findByProject(
            requireString(a, 'projectId'),
            optionalString(a, 'category'),
          );
          result = compactList(manuals as any, ['content', '__v']);
          break;
        }
        case 'manual_get': {
          result = await manualsService.findById(requireString(a, 'id'));
          break;
        }
        case 'manual_update': {
          const updated = await manualsService.update(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            content: optionalString(a, 'content'),
            category: optionalString(a, 'category'),
            sortOrder: optionalNumber(a, 'sortOrder'),
          });
          result = compactUpdateResult(updated);
          break;
        }
        case 'manual_delete': {
          await manualsService.delete(requireString(a, 'id'));
          result = { deleted: true };
          break;
        }
        case 'research_save': {
          const rEntry = await researchService.create({
            projectId: requireString(a, 'projectId'),
            title: requireString(a, 'title'),
            content: requireString(a, 'content'),
            sources: optionalStringArray(a, 'sources'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(rEntry, { title: (rEntry as any).title });
          break;
        }
        case 'research_search': {
          const rProjectId = optionalString(a, 'projectId');
          const rSearchResults = await researchService.search(
            requireString(a, 'query'),
            rProjectId,
          );
          const rLimited = rSearchResults.slice(0, optionalNumber(a, 'limit') || 10);
          result = rLimited.map((item: any) => {
            const obj = typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
            if (rProjectId) {
              obj.content = snippet(obj.content);
            } else {
              delete obj.content;
            }
            obj.sourceCount = (obj.sources || []).length;
            delete obj.sources;
            delete obj.__v;
            return obj;
          });
          break;
        }
        case 'research_list': {
          const rEntries = await researchService.findByProject(requireString(a, 'projectId'));
          const compactResearch = rEntries.map((item: any) => {
            const obj = typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
            delete obj.content;
            obj.sourceCount = (obj.sources || []).length;
            delete obj.sources;
            delete obj.__v;
            return obj;
          });
          result = applyPagination(compactResearch, optionalNumber(a, 'limit'), optionalNumber(a, 'offset'));
          break;
        }
        case 'research_get':
          result = await researchService.findById(requireString(a, 'id'));
          break;
        case 'research_update':
          result = compactUpdateResult(await researchService.update(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            content: optionalString(a, 'content'),
            sources: optionalStringArray(a, 'sources'),
            tags: optionalStringArray(a, 'tags'),
          }));
          break;
        case 'research_delete':
          await researchService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'system_instructions_get': {
          const instructions = await settingsService.getOrDefault(
            AGENT_INSTRUCTIONS_KEY,
            DEFAULT_AGENT_INSTRUCTIONS,
          );
          const projectId = optionalString(a, 'projectId');
          if (projectId) {
            const project = await projectsService.findById(projectId);
            if (project?.instructions) {
              result = {
                globalInstructions: instructions,
                projectInstructions: project.instructions,
              };
              break;
            }
          }
          result = { globalInstructions: instructions };
          break;
        }
        case 'system_instructions_set': {
          await settingsService.set(
            AGENT_INSTRUCTIONS_KEY,
            requireString(a, 'instructions'),
          );
          result = { updated: true };
          break;
        }
        case 'schema_create': {
          const schema = await schemasService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            dbType: requireString(a, 'dbType') as any,
            database: optionalString(a, 'database'),
            description: optionalString(a, 'description'),
            fields: (a.fields as any[]) || [],
            indexes: (a.indexes as any[]) || [],
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(schema, { name: (schema as any).name });
          break;
        }
        case 'schema_list': {
          const schemas = await schemasService.findByProject(
            requireString(a, 'projectId'),
            optionalString(a, 'dbType'),
            optionalStringArray(a, 'tags'),
          );
          const compactSchemas = compactList(schemas as any, ['fields', 'indexes', '__v']);
          result = applyPagination(compactSchemas, optionalNumber(a, 'limit'), optionalNumber(a, 'offset'));
          break;
        }
        case 'schema_get':
          result = await schemasService.findById(requireString(a, 'id'));
          break;
        case 'schema_update': {
          const updateData: Record<string, unknown> = {};
          if (a.name !== undefined) updateData.name = a.name;
          if (a.dbType !== undefined) updateData.dbType = a.dbType;
          if (a.database !== undefined) updateData.database = a.database;
          if (a.description !== undefined) updateData.description = a.description;
          if (a.fields !== undefined) updateData.fields = a.fields;
          if (a.indexes !== undefined) updateData.indexes = a.indexes;
          if (a.tags !== undefined) updateData.tags = a.tags;
          if (a.changeNote !== undefined) updateData.changeNote = a.changeNote;
          result = compactUpdateResult(await schemasService.update(requireString(a, 'id'), updateData as any));
          break;
        }
        case 'schema_delete':
          await schemasService.remove(requireString(a, 'id'));
          result = { deleted: true, id: requireString(a, 'id') };
          break;
        case 'schema_versions': {
          const ver = optionalNumber(a, 'version');
          if (ver !== undefined) {
            result = await schemasService.getVersion(requireString(a, 'schemaId'), ver);
          } else {
            const versions = await schemasService.getVersions(requireString(a, 'schemaId'));
            result = (versions as any[]).map((v: any) => {
              const obj = typeof v.toJSON === 'function' ? v.toJSON() : { ...v };
              return {
                _id: obj._id,
                version: obj.version,
                changeNote: obj.changeNote,
                createdAt: obj.createdAt,
              };
            });
          }
          break;
        }
        case 'feature_create': {
          const feat = await featuresService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            category: optionalString(a, 'category'),
            status: optionalString(a, 'status') as any,
            version: optionalString(a, 'version'),
            priority: optionalString(a, 'priority') as any,
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(feat, { name: (feat as any).name });
          break;
        }
        case 'feature_list': {
          const features = await featuresService.findByProject(requireString(a, 'projectId'), {
            status: optionalString(a, 'status') as any,
            category: optionalString(a, 'category'),
          });
          result = applyPagination(
            compactList(features as any, ['description', '__v']),
            optionalNumber(a, 'limit'),
            optionalNumber(a, 'offset'),
          );
          break;
        }
        case 'feature_get':
          result = await featuresService.findById(requireString(a, 'id'));
          break;
        case 'feature_update':
          result = compactUpdateResult(await featuresService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            category: optionalString(a, 'category'),
            status: optionalString(a, 'status') as any,
            version: optionalString(a, 'version'),
            priority: optionalString(a, 'priority') as any,
            tags: optionalStringArray(a, 'tags'),
          }));
          break;
        case 'feature_delete':
          await featuresService.remove(requireString(a, 'id'));
          result = { deleted: true, id: requireString(a, 'id') };
          break;
        case 'dependency_add': {
          const dep = await dependenciesService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            version: requireString(a, 'version'),
            packageManager: requireString(a, 'packageManager') as any,
            description: optionalString(a, 'description'),
            devDependency: a.devDependency === true,
            category: optionalString(a, 'category'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(dep, { name: (dep as any).name, version: (dep as any).version });
          break;
        }
        case 'dependency_list': {
          const deps = await dependenciesService.findByProject(requireString(a, 'projectId'), {
            packageManager: optionalString(a, 'packageManager') as any,
            category: optionalString(a, 'category'),
            devDependency: a.devDependency !== undefined ? a.devDependency === true : undefined,
          });
          result = applyPagination(
            compactList(deps as any, ['description', 'tags', '__v']),
            optionalNumber(a, 'limit'),
            optionalNumber(a, 'offset'),
          );
          break;
        }
        case 'dependency_get':
          result = await dependenciesService.findById(requireString(a, 'id'));
          break;
        case 'dependency_update':
          result = compactUpdateResult(await dependenciesService.update(requireString(a, 'id'), {
            version: optionalString(a, 'version'),
            description: optionalString(a, 'description'),
            devDependency: a.devDependency !== undefined ? a.devDependency === true : undefined,
            category: optionalString(a, 'category'),
            tags: optionalStringArray(a, 'tags'),
          }));
          break;
        case 'dependency_delete':
          await dependenciesService.remove(requireString(a, 'id'));
          result = { deleted: true, id: requireString(a, 'id') };
          break;
        case 'dependency_scan': {
          const scanResult = await dependenciesService.bulkCreate({
            projectId: requireString(a, 'projectId'),
            packageManager: requireString(a, 'packageManager') as any,
            dependencies: a.dependencies as any,
          });
          result = scanResult;
          break;
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }

      return textResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`Error: ${message}`);
    }
  });
}
