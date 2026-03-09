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

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
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
    description: 'List all tracked projects',
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
    description: 'List todos, optionally filtered by project and/or status',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'], description: 'Filter by status' },
      },
    },
  },
  {
    name: 'todo_update',
    description: 'Update a todo (e.g. change status, priority). IMPORTANT: Status transitions must follow the order open -> in_progress -> review -> done (one step at a time, forward or backward). Skipping steps will be rejected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        milestoneId: { type: 'string', description: 'Milestone MongoDB ID to associate with' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Array of Todo MongoDB IDs that block this todo' },
        archived: { type: 'boolean', description: 'Archive or unarchive a todo' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_delete',
    description: 'Delete a todo',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_comment',
    description: 'Add a comment to a todo',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
        text: { type: 'string', description: 'Comment text' },
        author: { type: 'string', description: 'Comment author (default: claude)' },
      },
      required: ['id', 'text'],
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
    description: 'Get the latest work session(s) for a project',
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
    description: 'Search the knowledge base by text query, optionally scoped to a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        projectId: { type: 'string', description: 'Scope search to a specific project' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_list',
    description: 'List all knowledge entries for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
      },
      required: ['projectId'],
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
    description: 'List changelog entries for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        limit: { type: 'number', description: 'Number of entries to return (default 50)' },
      },
      required: ['projectId'],
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
    description: 'List milestones for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'], description: 'Filter by status' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'milestone_get',
    description: 'Get a milestone by ID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Milestone MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'milestone_update',
    description: 'Update a milestone',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Milestone MongoDB ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        dueDate: { type: 'string', description: 'Due date (ISO 8601)' },
        archived: { type: 'boolean', description: 'Archive or unarchive a milestone' },
      },
      required: ['id'],
    },
  },
  {
    name: 'milestone_delete',
    description: 'Delete a milestone',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Milestone MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notify_user',
    description: 'Send a push notification to the user via the ClaudeVault PWA. Use this to inform the user about completed tasks, important updates, or when you need their attention.',
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
    description: 'List all environments for a project',
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
    name: 'manual_save',
    description: 'Save or update the user manual for a project. The manual is a single markdown document per project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        content: { type: 'string', description: 'Manual content in Markdown format' },
        title: { type: 'string', description: 'Manual title (default: Benutzerhandbuch)' },
      },
      required: ['projectId', 'content'],
    },
  },
  {
    name: 'manual_get',
    description: 'Get the user manual for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
      },
      required: ['projectId'],
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
    name: 'research_list',
    description: 'List all research entries for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
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
];

export function registerMcpTools(server: Server, services: McpServices): void {
  const { projectsService, todosService, sessionsService, knowledgeService, changelogService, milestonesService, activitiesService, pushService, environmentsService, secretsService, manualsService, researchService } = services;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case 'project_create':
          result = await projectsService.create({
            name: requireString(a, 'name'),
            path: optionalString(a, 'path'),
            description: optionalString(a, 'description'),
            techStack: optionalStringArray(a, 'techStack'),
            repository: optionalString(a, 'repository'),
            instructions: optionalString(a, 'instructions'),
            components: a.components as any,
          });
          break;
        case 'project_list':
          result = await projectsService.findAll(optionalBoolean(a, 'active'));
          break;
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
          result = await projectsService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            path: optionalString(a, 'path'),
            description: optionalString(a, 'description'),
            techStack: optionalStringArray(a, 'techStack'),
            repository: optionalString(a, 'repository'),
            active: optionalBoolean(a, 'active'),
            instructions: optionalString(a, 'instructions'),
            components: a.components as any,
          });
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
          ]);
          result = { deleted: true, id };
          break;
        }
        case 'todo_create':
          result = await todosService.create({
            projectId: requireString(a, 'projectId'),
            title: requireString(a, 'title'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            priority: optionalString(a, 'priority') as any,
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            blockedBy: optionalStringArray(a, 'blockedBy'),
          });
          break;
        case 'todo_list':
          result = await todosService.findAll({
            projectId: optionalString(a, 'projectId'),
            status: optionalString(a, 'status') as any,
          });
          break;
        case 'todo_update':
          result = await todosService.update(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            priority: optionalString(a, 'priority') as any,
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            blockedBy: optionalStringArray(a, 'blockedBy'),
            archived: optionalBoolean(a, 'archived'),
          });
          break;
        case 'todo_delete':
          await todosService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'todo_comment':
          result = await todosService.addComment(
            requireString(a, 'id'),
            requireString(a, 'text'),
            optionalString(a, 'author') || 'claude',
          );
          break;
        case 'session_save':
          result = await sessionsService.create({
            projectId: requireString(a, 'projectId'),
            summary: requireString(a, 'summary'),
            filesChanged: optionalStringArray(a, 'filesChanged'),
            nextSteps: optionalStringArray(a, 'nextSteps'),
            openQuestions: optionalStringArray(a, 'openQuestions'),
          });
          break;
        case 'session_get': {
          const projectId = requireString(a, 'projectId');
          const limit = optionalNumber(a, 'limit') || 1;
          if (limit > 1) {
            result = await sessionsService.findByProject(projectId, limit);
          } else {
            result = await sessionsService.findLatest(projectId);
            if (!result) return textResult({ message: 'No sessions found for this project.' });
          }
          break;
        }
        case 'knowledge_save':
          result = await knowledgeService.create({
            projectId: requireString(a, 'projectId'),
            topic: requireString(a, 'topic'),
            content: requireString(a, 'content'),
            tags: optionalStringArray(a, 'tags'),
            category: optionalString(a, 'category'),
          });
          break;
        case 'knowledge_search':
          result = await knowledgeService.search(
            requireString(a, 'query'),
            optionalString(a, 'projectId'),
          );
          break;
        case 'knowledge_list':
          result = await knowledgeService.findByProject(requireString(a, 'projectId'));
          break;
        case 'knowledge_update':
          result = await knowledgeService.update(requireString(a, 'id'), {
            topic: optionalString(a, 'topic'),
            content: optionalString(a, 'content'),
            tags: optionalStringArray(a, 'tags'),
            category: optionalString(a, 'category'),
          });
          break;
        case 'knowledge_delete':
          await knowledgeService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'changelog_add':
          result = await changelogService.create({
            projectId: requireString(a, 'projectId'),
            version: optionalString(a, 'version'),
            changes: a.changes as string[],
            summary: optionalString(a, 'summary'),
            component: optionalString(a, 'component'),
          });
          break;
        case 'changelog_list':
          result = await changelogService.findByProject(
            requireString(a, 'projectId'),
            optionalNumber(a, 'limit'),
          );
          break;
        case 'changelog_update':
          result = await changelogService.update(requireString(a, 'id'), {
            version: optionalString(a, 'version'),
            changes: optionalStringArray(a, 'changes'),
            summary: optionalString(a, 'summary'),
            component: optionalString(a, 'component'),
          });
          break;
        case 'changelog_delete':
          await changelogService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'milestone_create':
          result = await milestonesService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            dueDate: optionalString(a, 'dueDate'),
          });
          break;
        case 'milestone_list':
          result = await milestonesService.findByProject(
            requireString(a, 'projectId'),
            optionalString(a, 'status') as any,
          );
          break;
        case 'milestone_get':
          result = await milestonesService.findById(requireString(a, 'id'));
          break;
        case 'milestone_update':
          result = await milestonesService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            status: optionalString(a, 'status') as any,
            dueDate: optionalString(a, 'dueDate'),
            archived: optionalBoolean(a, 'archived'),
          });
          break;
        case 'milestone_delete':
          await milestonesService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'notify_user':
          result = await pushService.sendNotification(
            requireString(a, 'title'),
            requireString(a, 'body'),
            optionalString(a, 'url'),
          );
          break;
        case 'environment_create':
          result = await environmentsService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            variables: a.variables as any,
            active: optionalBoolean(a, 'active'),
          });
          break;
        case 'environment_list':
          result = await environmentsService.findByProject(requireString(a, 'projectId'));
          break;
        case 'environment_get':
          result = await environmentsService.findById(requireString(a, 'id'));
          break;
        case 'environment_update':
          result = await environmentsService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            variables: a.variables as any,
            active: optionalBoolean(a, 'active'),
          });
          break;
        case 'environment_delete':
          await environmentsService.delete(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'secret_set':
          result = await secretsService.create({
            projectId: requireString(a, 'projectId'),
            environmentId: optionalString(a, 'environmentId'),
            key: requireString(a, 'key'),
            value: requireString(a, 'value'),
            description: optionalString(a, 'description'),
          });
          break;
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
        case 'manual_save':
          result = await manualsService.save({
            projectId: requireString(a, 'projectId'),
            content: requireString(a, 'content'),
            title: optionalString(a, 'title'),
          });
          break;
        case 'manual_get': {
          const manual = await manualsService.findByProject(requireString(a, 'projectId'));
          if (!manual) return textResult({ message: 'No manual found for this project.' });
          result = manual;
          break;
        }
        case 'research_save':
          result = await researchService.create({
            projectId: requireString(a, 'projectId'),
            title: requireString(a, 'title'),
            content: requireString(a, 'content'),
            sources: optionalStringArray(a, 'sources'),
            tags: optionalStringArray(a, 'tags'),
          });
          break;
        case 'research_list':
          result = await researchService.findByProject(requireString(a, 'projectId'));
          break;
        case 'research_get':
          result = await researchService.findById(requireString(a, 'id'));
          break;
        case 'research_update':
          result = await researchService.update(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            content: optionalString(a, 'content'),
            sources: optionalStringArray(a, 'sources'),
            tags: optionalStringArray(a, 'tags'),
          });
          break;
        case 'research_delete':
          await researchService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
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
