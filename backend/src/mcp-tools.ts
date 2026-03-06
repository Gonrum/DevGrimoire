import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ProjectsService } from './projects/projects.service';
import { TodosService } from './todos/todos.service';
import { SessionsService } from './sessions/sessions.service';
import { KnowledgeService } from './knowledge/knowledge.service';

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
    description: 'Update a todo (e.g. change status, priority)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo MongoDB ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
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
];

export function registerMcpTools(server: Server, services: McpServices): void {
  const { projectsService, todosService, sessionsService, knowledgeService } = services;

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
          });
          break;
        case 'project_delete': {
          const id = requireString(a, 'id');
          await projectsService.remove(id);
          await Promise.all([
            todosService.removeByProject(id),
            sessionsService.removeByProject(id),
            knowledgeService.removeByProject(id),
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
          });
          break;
        case 'knowledge_delete':
          await knowledgeService.remove(requireString(a, 'id'));
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
