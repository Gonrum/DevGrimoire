import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { UI_RESOURCES, findUiResource, TODO_UI_RESOURCE_URI } from './mcp-apps/resources';
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
import { ResearchTopicService } from './research-agent/research-topic.service';
import { ResearchRunService } from './research-agent/research-run.service';
import { ResearchArtifactService } from './research-agent/research-artifact.service';
import { ResearchAgentService } from './research-agent/research-agent.service';
import { ResearchRunStatus } from './research-agent/schemas/research-run.schema';
import { SettingsService } from './settings/settings.service';
import { NotificationsService } from './notifications/notifications.service';
import { SchemasService } from './schemas/schemas.service';
import { DependenciesService } from './dependencies/dependencies.service';
import { FeaturesService } from './features/features.service';
import { SoulsService } from './souls/souls.service';
import { HarnessService } from './harness/harness.service';
import { HARNESS_SCOPES, HARNESS_SECTION_KINDS, HARNESS_MERGE_STRATEGIES } from './harness/harness.types';
import { CommitsService } from './commits/commits.service';
import { RagService } from './rag/rag.service';
import { RecurringTasksService } from './recurring-tasks/recurring-tasks.service';
import { WorkflowsService } from './workflows/workflows.service';
import { WorkflowEngineService } from './workflows/engine/workflow-engine.service';
import { NodeRegistry } from './workflows/engine/node-registry';
import { CustomerTemplatesService } from './customer-templates/customer-templates.service';
import { ValidationReportsService } from './validation-reports/validation-reports.service';
import { DocUpdateProposalsService } from './doc-update-proposals/doc-update-proposals.service';
import { KnowledgeGraphService } from './knowledge-graph/knowledge-graph.service';
import { KG_ENTITY_TYPES, KG_RELATIONS } from './knowledge-graph/schemas/knowledge-graph-edge.schema';
import { OracleService } from './oracle/oracle.service';
import { SnippetsService } from './snippets/snippets.service';
import { WorkspacesService } from './workspaces/workspaces.service';
import { WorkspaceClient } from './workspaces/workspace-client.service';
import { WorkspaceGitTokensService } from './workspaces/workspace-git-tokens.service';
import { WorkspaceCliTokenService } from './workspaces/workspace-cli-token.service';
import { assertWorkspaceWithinClientRoots, McpRootLike } from './workspaces/workspace-roots.guard';
import { AttachmentsService } from './attachments/attachments.service';
import { QuestionsService } from './questions/questions.service';
import { LogsService } from './logs/logs.service';
import { ReleasesService } from './releases/releases.service';
import { ChatService } from './chat/chat.service';
import { ChatLlmService } from './chat/chat-llm.service';
import { ChatContextService } from './chat/chat-context.service';
import { WebSearchService } from './web-search/services/web-search.service';
import { StacksService } from './stacks/stacks.service';
import { ReadabilityService } from './web-search/services/readability.service';
import { SearchCategory, SearchTimeRange } from './web-search/dto/web-search.dto';
import type { ParsedTodo, ParsedMilestone } from './milestones/milestones.service';
import type { CreateKnowledgeDto } from './knowledge/dto/create-knowledge.dto';
import type { BodyDto } from './http-requests/dto/create-request.dto';
import { RequestContext } from './common/request-context';
import { AGENT_INSTRUCTIONS_KEY, DEFAULT_AGENT_INSTRUCTIONS } from './settings/default-agent-instructions';
import { AuthService } from './auth/auth.service';
import { CustomersService } from './customers/customers.service';
import { ContactsService } from './contacts/contacts.service';
import { MonitoringService } from './monitoring/monitoring.service';
import { HttpRequestsService } from './http-requests/http-requests.service';
import { SshService } from './ssh/ssh.service';
import { SshSessionService } from './ssh/ssh-session.service';
import { SshConnectionDocument } from './ssh/schemas/ssh-connection.schema';
import type { SshConnectionWithInheritance } from './ssh/ssh.service';
import { SshAuditDocument } from './ssh/schemas/ssh-audit.schema';
import { computeEffectiveUploadLimit } from './ssh/upload-limit.util';
import {
  assertSha256Matches,
  decodeBase64Strict,
} from './ssh/upload-integrity.util';
/*
 * Enum-Importe für `optionalEnum`/`requireEnum`: die Wertelisten kommen aus dem
 * Schema bzw. DTO, das das Feld definiert — `Object.values(X)` bei TS-String-
 * Enums, eine `as const`-Liste weiter unten bei String-Literal-Unions.
 */
import { CustomerStatus } from './customers/schemas/customer.schema';
import { CustomerProjectLinkStatus } from './customers/schemas/customer-project-link.schema';
import { TodoStatus, TodoPriority } from './todos/schemas/todo.schema';
import { MilestoneStatus } from './milestones/schemas/milestone.schema';
import { DbType } from './schemas/schemas/db-schema.schema';
import { FeatureStatus, FeaturePriority } from './features/schemas/feature.schema';
import { ReleaseType, ReleasePlatform, ReleaseStatus } from './releases/schemas/release.schema';
import { PackageManager } from './dependencies/schemas/dependency.schema';
import { RecurringFrequency } from './recurring-tasks/schemas/recurring-task.schema';
import { ValidationReportStatus } from './validation-reports/schemas/validation-report.schema';
import {
  DocProposalStatus,
  DocProposalSourceType,
  DocProposalTargetType,
} from './doc-update-proposals/schemas/doc-update-proposal.schema';
import {
  OracleRiskType,
  OracleSeverity,
  OracleSuggestionStatus,
} from './oracle/schemas/oracle-suggestion.schema';
import { WorkflowScope, WorkflowStatus } from './workflows/schemas/workflow-definition.schema';
import { CustomerTemplateType } from './customer-templates/schemas/customer-template.schema';
import { HealthcheckMethod } from './monitoring/schemas/healthcheck.schema';
import { HttpRequestMethod } from './http-requests/schemas/saved-request.schema';
import type { WorkflowNodeDto, WorkflowEdgeDto } from './workflows/dto/workflow.dto';
import type { CustomerTemplateItemDto } from './customer-templates/dto/customer-template.dto';
import type { WorkspaceStatus } from './workspaces/schemas/workspace.schema';
/*
 * Argument-Leser und Dokument-Helfer liegen seit M-52/T-457 gemeinsam in
 * `common/tool-args.ts` — dieselben Helfer lagen vorher hier und in
 * `chat-tools.ts` doppelt. `requireString`/`optionalString` sind dort bewusst
 * nicht mehr generisch: die alte Signatur `optionalString<T extends string>`
 * hat den engen Typ nur behauptet (`val as T`). Wo ein Enum gebraucht wird,
 * steht jetzt `optionalEnum`/`requireEnum` mit echter Laufzeitprüfung.
 */
import {
  type PlainDoc,
  asObjectArray,
  asString,
  countArray,
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
  requireNumber,
  requireObject,
  requireString,
  toPlainDoc,
} from './common/tool-args';

/*
 * Wertelisten für Felder, deren Typ ein String-Literal-Union ist statt eines
 * TS-Enums. Ein Union existiert zur Laufzeit nicht, `Object.values()` gibt es
 * dafür also nicht — `optionalEnum` braucht die Werte trotzdem. Die
 * Typannotation koppelt die Liste an den Union: verschwindet dort ein Wert,
 * meldet der Compiler es hier.
 */
const KNOWLEDGE_SCOPES: readonly NonNullable<CreateKnowledgeDto['scope']>[] = [
  'global',
  'project',
  'customer',
];
const QUESTION_KNOWLEDGE_SCOPES = ['global', 'project'] as const;
/*
 * Drei DTOs (question_create_followup_todo, doc_update_proposal_convert_to_todo,
 * oracle_convert_to_todo) tippen die Todo-Priorität als String-Literal-Union
 * statt über das `TodoPriority`-Enum. Die Werte sind dieselben, die Typen sind
 * es nicht: ein TS-String-Enum ist nominal, `TodoPriority.LOW` ist keinem
 * `'low'` zuweisbar. Darum diese eigene Liste.
 */
const TODO_PRIORITY_LITERALS = ['low', 'medium', 'high', 'critical'] as const;
const KG_EDGE_DIRECTIONS = ['directed', 'undirected'] as const;
/** `createdBy` von Graph-Kanten und Doc-Update-Proposals — dieselben drei Werte. */
const ENTITY_CREATORS = ['system', 'agent', 'user'] as const;
const ESCALATION_KINDS = ['user', 'role', 'broadcast'] as const;
const SEARCH_CATEGORIES: readonly SearchCategory[] = ['general', 'news', 'science', 'it', 'files'];
const SEARCH_TIME_RANGES: readonly SearchTimeRange[] = ['day', 'week', 'month', 'year'];
const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ['active', 'archived', 'cleaning'];

/**
 * Narrowt ein `unknown` auf ein Objekt, ohne zu behaupten. Ein Typprädikat
 * statt `as Record<string, unknown>`: geprüft wird dieselbe Bedingung, die die
 * Assertion vorher nur unterstellt hat.
 */
function isPlainRecord(value: unknown): value is PlainDoc {
  return value !== null && typeof value === 'object';
}

const RAG_BACKEND_URL = process.env.RAG_BACKEND_URL || 'http://localhost:3200';

function ragHeaders(): Record<string, string> {
  const apiKey = process.env.DEVGRIMOIRE_API_KEY;
  if (apiKey) return { Authorization: `Bearer ${apiKey}` };
  return {};
}

async function ragHttpGet(path: string): Promise<unknown> {
  const res = await fetch(`${RAG_BACKEND_URL}${path}`, { headers: ragHeaders() });
  if (!res.ok) throw new Error(`RAG backend error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ragHttpPost(path: string): Promise<unknown> {
  const res = await fetch(`${RAG_BACKEND_URL}${path}`, { method: 'POST', headers: ragHeaders() });
  if (!res.ok) throw new Error(`RAG backend error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function backendHttpPostJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${RAG_BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { ...ragHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Backend error: ${res.status} ${await res.text()}`);
  return res.json();
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Compact JSON view of a Question doc for MCP. Strips Mongoose internals and
 * keeps only the fields an agent needs to decide what to do.
 */
function serializeQuestion(q: unknown): Record<string, unknown> {
  const obj = toPlainDoc(q);
  return {
    _id: obj._id,
    direction: obj.direction,
    status: obj.status,
    question: obj.question,
    options: obj.options,
    context: obj.context,
    answer: obj.answer,
    todoId: obj.todoId,
    projectId: obj.projectId,
    customerId: obj.customerId,
    researchSessionId: obj.researchSessionId,
    chatSessionId: obj.chatSessionId,
    milestoneId: obj.milestoneId,
    targetUserId: obj.targetUserId,
    targetRole: obj.targetRole,
    broadcast: obj.broadcast,
    resolvedTargetUserIds: obj.resolvedTargetUserIds,
    createdByUserId: obj.createdByUserId,
    answeredByUserId: obj.answeredByUserId,
    answeredByAgent: obj.answeredByAgent,
    answeredAt: obj.answeredAt,
    responses: obj.responses,
    knowledgeId: obj.knowledgeId,
    decisionKnowledgeId: obj.decisionKnowledgeId,
    followupTodoId: obj.followupTodoId,
    snoozeUntil: obj.snoozeUntil,
    closeReason: obj.closeReason,
    supersededByQuestionId: obj.supersededByQuestionId,
    expiresAt: obj.expiresAt,
    agentRunId: obj.agentRunId,
    agentName: obj.agentName,
    escalationChain: obj.escalationChain,
    escalationStep: obj.escalationStep,
    escalationHistory: obj.escalationHistory,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

/**
 * Resolve the userId for per-user scoped tools (chat_*).
 * - HTTP MCP transport: derived from the API key during auth middleware via RequestContext
 * - stdio MCP: falls back to MCP_STDIO_USER_ID env (set at bootstrap from first admin)
 * Throws if neither is available.
 */
function requireUserId(): string {
  const userId = RequestContext.getUser()?.userId || process.env.MCP_STDIO_USER_ID;
  if (!userId) {
    throw new Error(
      'No user context available — set MCP_STDIO_USER_ID env or call this tool via an authenticated MCP transport.',
    );
  }
  return userId;
}

function compactList(items: unknown[], stripFields: string[]): PlainDoc[] {
  return items.map((item) => {
    const obj = toPlainDoc(item);
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

export function compactUpdateResult(doc: unknown): PlainDoc {
  const obj = toPlainDoc(doc);
  return {
    updated: true,
    _id: idToString(obj._id),
    projectId: idToString(obj.projectId),
    customerId: idToString(obj.customerId),
    updatedAt: obj.updatedAt,
  };
}

export function compactCreateResult(doc: unknown, extra?: Record<string, unknown>): PlainDoc {
  const obj = toPlainDoc(doc);
  return {
    created: true,
    _id: idToString(obj._id),
    projectId: idToString(obj.projectId),
    customerId: idToString(obj.customerId),
    createdAt: obj.createdAt,
    ...extra,
  };
}

/**
 * Derive the high-level connection status from the persisted error/fingerprint
 * fields. Mirrors what the SSH UI shows so MCP callers see the same picture
 * as the dashboard.
 *
 * Precedence is intentional and matches the spec:
 *   1) `lastConnectError` set → 'error' (most actionable)
 *   2) no `knownHostFingerprint` → 'fingerprint_pending' (user must TOFU)
 *   3) `lastConnectedAt` set → 'ok' (we've been there before)
 *   4) otherwise → 'never_tested'
 */
export function deriveSshStatus(
  doc: Pick<SshConnectionDocument, 'lastConnectError' | 'knownHostFingerprint' | 'lastConnectedAt'>,
): 'ok' | 'never_tested' | 'error' | 'fingerprint_pending' {
  if (doc.lastConnectError) return 'error';
  if (!doc.knownHostFingerprint) return 'fingerprint_pending';
  if (doc.lastConnectedAt) return 'ok';
  return 'never_tested';
}

/**
 * Project an SshConnection document into the safe MCP list/get shape. NEVER
 * includes credential references (privateKeySecretId/passphraseSecretId/
 * passwordSecretId) or the host-key fingerprint — defense-in-depth so a
 * compromised tool can't exfiltrate them via discovery.
 */
function serializeSshConnectionForMcp(
  doc: SshConnectionDocument,
): Record<string, unknown> {
  // `inheritedFromCustomerId` is a synthetic marker stamped by
  // SshService.findByProjectId when a queried project is linked to a
  // customer that owns this connection (T-386). It's only present on
  // documents returned from the project-scoped list path; customer-scoped
  // queries never set it.
  const inheritedFromCustomerId = (doc as SshConnectionWithInheritance)
    .inheritedFromCustomerId;
  return {
    id: idToString(doc._id),
    slug: doc.slug,
    label: doc.label,
    host: doc.host,
    port: doc.port,
    username: doc.username,
    authMethod: doc.authMethod,
    scope: {
      projectId: idToString(doc.projectId),
      customerId: idToString(doc.customerId),
    },
    tags: doc.tags,
    description: doc.description,
    status: deriveSshStatus(doc),
    lastConnectedAt: doc.lastConnectedAt,
    ...(inheritedFromCustomerId ? { inheritedFromCustomerId } : {}),
  };
}

/**
 * Compact a SshAudit row for MCP. Only safe fields surface — no command text,
 * no remotePath, no userId. Callers want to know "did the last op succeed",
 * not the full audit trail (that's what the REST `/audit` endpoint is for).
 */
function serializeSshAuditForMcp(
  audit: SshAuditDocument,
): Record<string, unknown> {
  return {
    at: audit.at,
    action: audit.action,
    sourceContext: audit.sourceContext,
    exitCode: audit.exitCode,
    errorMsg: audit.errorMsg,
  };
}

/**
 * Resolve an SshConnection from MCP-tool args. Logic:
 *   - `id` wins outright (no scope needed)
 *   - else `slug` + (projectId XOR customerId)
 *   - missing both id and slug → 'connection_identifier_required'
 *   - slug without scope → 'slug_requires_scope'
 *   - resolved-but-not-found → 'connection_not_found'
 *
 * Defensive: never exposes the raw Mongo error to the LLM.
 */
async function resolveSshConnection(
  sshService: SshService,
  args: { id?: string; slug?: string; projectId?: string; customerId?: string },
): Promise<SshConnectionDocument> {
  if (args.id) {
    try {
      return await sshService.findById(args.id);
    } catch {
      throw new Error('connection_not_found');
    }
  }
  if (!args.slug) {
    throw new Error('connection_identifier_required');
  }
  if (!args.projectId && !args.customerId) {
    throw new Error('slug_requires_scope');
  }
  const found = await sshService.findBySlug(args.slug, {
    projectId: args.projectId,
    customerId: args.customerId,
  });
  if (!found) throw new Error('connection_not_found');
  return found;
}

/**
 * Heuristic for "is this buffer safe to send back as a UTF-8 string?". We
 * reject any null byte (most-common quick-check for binary) and verify the
 * round-trip through `Buffer.from(s, 'utf8')` matches the original bytes — so
 * malformed UTF-8 sequences flip the result to base64 too.
 */
export function isUtf8RoundTripSafe(buf: Buffer): boolean {
  if (buf.indexOf(0) !== -1) return false;
  const s = buf.toString('utf8');
  return Buffer.from(s, 'utf8').equals(buf);
}

async function getClientRoots(server: Server): Promise<McpRootLike[] | undefined> {
  try {
    const result = await server.listRoots(undefined, { timeout: 2_000 });
    return result.roots.map((root) => ({ uri: root.uri, name: root.name }));
  } catch {
    // Older clients and some transports do not support MCP roots yet. Roots are
    // an extra narrowing boundary, not a requirement for existing workspaces.
    return undefined;
  }
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
  researchTopicService: ResearchTopicService;
  researchRunService: ResearchRunService;
  researchArtifactService: ResearchArtifactService;
  researchAgentService: ResearchAgentService;
  settingsService: SettingsService;
  notificationsService: NotificationsService;
  schemasService: SchemasService;
  dependenciesService: DependenciesService;
  featuresService: FeaturesService;
  soulsService: SoulsService;
  harnessService: HarnessService;
  commitsService: CommitsService;
  ragService: RagService;
  recurringTasksService: RecurringTasksService;
  workflowsService: WorkflowsService;
  workflowEngineService: WorkflowEngineService;
  nodeRegistry: NodeRegistry;
  customerTemplatesService: CustomerTemplatesService;
  validationReportsService: ValidationReportsService;
  docUpdateProposalsService: DocUpdateProposalsService;
  knowledgeGraphService: KnowledgeGraphService;
  oracleService: OracleService;
  snippetsService: SnippetsService;
  attachmentsService: AttachmentsService;
  questionsService: QuestionsService;
  authService: AuthService;
  customersService: CustomersService;
  contactsService: ContactsService;
  monitoringService: MonitoringService;
  httpRequestsService: HttpRequestsService;
  logsService: LogsService;
  releasesService: ReleasesService;
  chatService: ChatService;
  chatLlmService: ChatLlmService;
  chatContextService: ChatContextService;
  webSearchService: WebSearchService;
  readabilityService: ReadabilityService;
  workspacesService: WorkspacesService;
  workspaceClient: WorkspaceClient;
  workspaceGitTokens: WorkspaceGitTokensService;
  workspaceCliToken: WorkspaceCliTokenService;
  sshService: SshService;
  sshSessionService: SshSessionService;
  stackService: StacksService;
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
        tags: { type: 'array', items: { type: 'string' }, description: 'User-defined tags for grouping projects in the overview. Order matters: tags[0] is the primary tag used for section grouping.' },
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
        tags: { type: 'array', items: { type: 'string' }, description: 'User-defined tags. Order matters: tags[0] is the primary tag used for section grouping in the overview.' },
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
    name: 'project_tag_list',
    description: 'List all project tags with usage count (number of projects using each tag).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'project_tag_rename',
    description: 'Rename a tag across all projects. If the target tag already exists on a project, the source tag is removed and the target is kept at its existing position (effective merge for that project).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Current tag name' },
        to: { type: 'string', description: 'New tag name' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'project_tag_merge',
    description: 'Merge multiple source tags into a target tag across all projects. Projects with any source tag get the target tag; sources are removed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sources: { type: 'array', items: { type: 'string' }, description: 'Source tag names to merge' },
        target: { type: 'string', description: 'Target tag name (kept)' },
      },
      required: ['sources', 'target'],
    },
  },
  {
    name: 'project_tag_delete',
    description: 'Remove a tag from all projects. Does not delete projects.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Tag name to remove' },
      },
      required: ['name'],
    },
  },
  {
    name: 'customer_create',
    description: 'Create a customer file. Customers are a top-level context for deployments, knowledge, workflows, environments, secrets, files, monitoring, and contacts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique customer name' },
        description: { type: 'string', description: 'Markdown-capable customer description' },
        status: { type: 'string', enum: ['lead', 'onboarding', 'active', 'paused', 'offboarding', 'cancelled', 'archived'], description: 'Customer lifecycle status' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering' },
        primaryContactName: { type: 'string', description: 'Primary contact name' },
        primaryContactEmail: { type: 'string', description: 'Primary contact email' },
        primaryContactPhone: { type: 'string', description: 'Primary contact phone' },
        website: { type: 'string', description: 'Customer website' },
        notes: { type: 'string', description: 'Internal customer-file notes' },
      },
      required: ['name'],
    },
  },
  {
    name: 'customer_list',
    description: 'List customer files (compact). Archived customers are excluded by default. Use customer_get for full details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['lead', 'onboarding', 'active', 'paused', 'offboarding', 'cancelled', 'archived'], description: 'Filter by lifecycle status' },
        tag: { type: 'string', description: 'Filter by exact tag' },
        q: { type: 'string', description: 'Text search over name, description, tags, and notes' },
        includeArchived: { type: 'boolean', description: 'Include archived customers' },
        projectId: { type: 'string', description: 'Filter customers linked to this project' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
    },
  },
  {
    name: 'customer_get',
    description: 'Get a customer file by MongoDB ID with full details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Customer MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'customer_update',
    description: 'Update a customer file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Customer MongoDB ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['lead', 'onboarding', 'active', 'paused', 'offboarding', 'cancelled', 'archived'] },
        tags: { type: 'array', items: { type: 'string' } },
        primaryContactName: { type: 'string' },
        primaryContactEmail: { type: 'string' },
        primaryContactPhone: { type: 'string' },
        website: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'customer_archive',
    description: 'Archive a customer file. This does not delete linked projects or other data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Customer MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'customer_project_link',
    description: 'Link a project to a customer as a deployment. A project can be linked to multiple customers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'Deployment status' },
        role: { type: 'string', description: 'Role of this project for the customer' },
        notes: { type: 'string', description: 'Deployment notes' },
        environmentIds: { type: 'array', items: { type: 'string' }, description: 'Environment IDs relevant for this customer deployment' },
      },
      required: ['customerId', 'projectId'],
    },
  },
  {
    name: 'customer_project_list',
    description: 'List project links/deployments for a customer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'customer_project_update',
    description: 'Update a customer-project link/deployment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
        linkId: { type: 'string', description: 'CustomerProjectLink MongoDB ID' },
        status: { type: 'string', enum: ['active', 'paused', 'archived'] },
        role: { type: 'string' },
        notes: { type: 'string' },
        environmentIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['customerId', 'linkId'],
    },
  },
  {
    name: 'customer_project_unlink',
    description: 'Remove a project link/deployment from a customer. This does not delete the project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
        linkId: { type: 'string', description: 'CustomerProjectLink MongoDB ID' },
      },
      required: ['customerId', 'linkId'],
    },
  },
  {
    name: 'project_customer_links',
    description: 'List all customer links/deployments for a project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'contact_create',
    description: 'Create a contact for a customer (named person with role, email, phone, notes).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
        name: { type: 'string', description: 'Contact name' },
        role: { type: 'string', description: 'Role/title at the customer' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        notes: { type: 'string', description: 'Free-form notes' },
        isPrimary: { type: 'boolean', description: 'Mark as primary/main contact' },
        sortOrder: { type: 'number', description: 'Manual sort order within the customer' },
      },
      required: ['customerId', 'name'],
    },
  },
  {
    name: 'contact_list',
    description: 'List all contacts for a customer (sorted: primary first, then by sortOrder).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'contact_get',
    description: 'Get a single contact by MongoDB ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Contact MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'contact_update',
    description: 'Update a contact.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Contact MongoDB ID' },
        name: { type: 'string' },
        role: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        notes: { type: 'string' },
        isPrimary: { type: 'boolean' },
        sortOrder: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'contact_delete',
    description: 'Delete a contact.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Contact MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_create',
    description: 'Create a new todo/task. Belongs to either a project (projectId) or a customer (customerId) — exactly one of the two is required. When the todo is derived from a spec, plan or detailed requirement, do NOT create it title-only: carry the substance into the structured Quest fields (userStories, acceptanceCriteria, outOfScope, edgeCases) and set blockedBy for dependencies. Copy measurable constraints from the source verbatim into acceptanceCriteria.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID for customer-scoped quests (mutually exclusive with projectId)' },
        title: { type: 'string', description: 'Todo title' },
        description: { type: 'string', description: 'Detailed description' },
        status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        milestoneId: { type: 'string', description: 'Milestone MongoDB ID to associate with' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Array of Todo MongoDB IDs that block this todo' },
        repoLabel: { type: 'string', description: 'Optional: associate todo with a specific repository label (e.g. "API", "Frontend")' },
        userStories: { type: 'string', description: 'User stories in markdown (As a … I want … so that …).' },
        acceptanceCriteria: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] }, description: 'Definition of done — checklist items with done flag.' },
        outOfScope: { type: 'string', description: 'Explicit boundaries — what is NOT part of this todo (markdown).' },
        edgeCases: { type: 'string', description: 'Edge cases / open questions (markdown). For interactive clarification use ask_user with todoId.' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Question MongoDB IDs linked to this todo. Set via ask_user with todoId rather than manually.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'todo_list',
    description: 'List todos (compact: id, title, status, priority, tags, milestoneId). Filter by projectId for project todos or customerId for customer-scoped quests. Archived todos are excluded by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
        customerId: { type: 'string', description: 'Filter by customer ID (customer-scoped quests)' },
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
    // M-35: MCP Apps Extension (io.modelcontextprotocol/ui). Apps-aware hosts
    // render the JSON result inside the linked HTML view (`ui://devgrimoire/todo`)
    // and pipe the structured payload via `ui/notifications/tool-result` to the
    // sandboxed iframe. Hosts without Apps support ignore this metadata —
    // fallback to plain JSON is automatic. See docs/mcp-apps.md.
    _meta: {
      ui: {
        resourceUri: TODO_UI_RESOURCE_URI,
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
        repoLabel: { type: 'string', description: 'Optional: associate todo with a specific repository label (e.g. "API", "Frontend")' },
        userStories: { type: 'string', description: 'User stories in markdown (As a … I want … so that …).' },
        acceptanceCriteria: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] }, description: 'Definition of done — checklist items with done flag.' },
        outOfScope: { type: 'string', description: 'Explicit boundaries — what is NOT part of this todo (markdown).' },
        edgeCases: { type: 'string', description: 'Edge cases / open questions (markdown). For interactive clarification use ask_user with todoId.' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Question MongoDB IDs linked to this todo. Set via ask_user with todoId rather than manually.' },
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
    name: 'todo_ask_question',
    description: 'Ask the user a question in the context of a specific todo. Creates an agent_to_user Question linked to the todo, shows it in the DevGrimoire UI, and waits for the user\'s answer. The question and answer are recorded as a comment on the todo and the question ID is added to todo.openQuestions. Use this instead of ask_user when you already have a todo context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        todoId: { type: 'string', description: 'Todo MongoDB ID' },
        question: { type: 'string', description: 'The question to ask the user' },
        options: { type: 'array', items: { type: 'string' }, description: 'Answer options (if omitted, user can type free text)' },
        context: { type: 'string', description: 'Additional context to help the user understand the question' },
        timeoutSeconds: { type: 'number', description: 'How long to wait for an answer (default: 300, max: 600)' },
        agentName: { type: 'string', description: 'Name of the requesting agent (for audit trail)' },
        agentRunId: { type: 'string', description: 'Agent run / task ID for correlation' },
      },
      required: ['todoId', 'question'],
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
    description: 'Save a knowledge entry (architecture decisions, patterns, conventions, notes). scope="global" = cross-project, scope="project" = projectId required, scope="customer" = customerId required (customer-scoped lore).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (required for scope="project")' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (required for scope="customer")' },
        scope: { type: 'string', enum: ['global', 'project', 'customer'], description: 'Scope: "global" cross-project, "project" project-specific, "customer" customer-specific (default: inferred from ids)' },
        topic: { type: 'string', description: 'Topic/title of the knowledge entry' },
        content: { type: 'string', description: 'The knowledge content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        category: { type: 'string', description: 'Category for grouping (e.g. Architecture, Patterns, Conventions)' },
      },
      required: ['topic', 'content'],
    },
  },
  {
    name: 'knowledge_search',
    description: 'Search knowledge base (returns compact results with content snippet). Use knowledge_get for full content. With projectId/customerId: returns matching scope + global results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        projectId: { type: 'string', description: 'Scope search to a project (also includes global entries)' },
        customerId: { type: 'string', description: 'Scope search to a customer (also includes global entries)' },
        scope: { type: 'string', enum: ['global', 'project', 'customer'], description: 'Filter strictly by scope' },
        limit: { type: 'number', description: 'Max items to return' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_list',
    description: 'List knowledge entries (compact: id, topic, tags, category, scope). With projectId or customerId: shows that scope + global entries. With scope="global": only global.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (shows project + global entries)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (shows customer + global entries)' },
        scope: { type: 'string', enum: ['global', 'project', 'customer'], description: 'Filter strictly by scope' },
        category: { type: 'string', description: 'Filter by category' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
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
    name: 'stack_create',
    description: 'Create a new standalone stack definition (tech-stack blueprint / "Bauplan"). Not project-scoped.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Stack name' },
        description: { type: 'string', description: 'Optional intro text (rendered above the sections on export)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'stack_list',
    description: 'List all stacks (metadata only: name, description, entryCount).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'stack_get',
    description: 'Get a stack with all its section entries (sorted by order).',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Stack id' } },
      required: ['id'],
    },
  },
  {
    name: 'stack_update',
    description: 'Update a stack name and/or description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'stack_delete',
    description: 'Delete a stack.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'stack_entry_add',
    description: 'Add a section entry (title + markdown content) to a stack.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Stack id' },
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown body (optional, may be empty)' },
      },
      required: ['id', 'title'],
    },
  },
  {
    name: 'stack_entry_update',
    description: 'Update a section entry (title, content and/or order).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Stack id' },
        entryId: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        order: { type: 'number' },
      },
      required: ['id', 'entryId'],
    },
  },
  {
    name: 'stack_entry_remove',
    description: 'Remove a section entry from a stack.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Stack id' },
        entryId: { type: 'string' },
      },
      required: ['id', 'entryId'],
    },
  },
  {
    name: 'stack_export_markdown',
    description: 'Export a stack as Markdown, or a single section if entryId is given.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Stack id' },
        entryId: { type: 'string', description: 'Optional: export only this section' },
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
        repoLabel: { type: 'string', description: 'Optional: associate changelog with a specific repository label (e.g. "API", "Frontend")' },
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
    description: 'Update a changelog entry (version, changes, summary, component, repoLabel)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Changelog entry MongoDB ID' },
        version: { type: 'string', description: 'Version number' },
        changes: { type: 'array', items: { type: 'string' }, description: 'List of changes' },
        summary: { type: 'string', description: 'Brief summary' },
        component: { type: 'string', description: 'Component name for monorepos' },
        repoLabel: { type: 'string', description: 'Optional: associate changelog with a specific repository label' },
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
    name: 'milestone_export',
    description: 'Export a milestone as Markdown, including all linked todos with their quest fields (User Stories, Acceptance Criteria, Out of Scope, Edge Cases). Provide either id OR number+projectId.',
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
    name: 'milestone_import_preview',
    description: 'Parse a Markdown string (milestone export format) and return the structured ParsedMilestone — no DB write. Use this to inspect what would be imported before calling milestone_import_apply.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        markdown: { type: 'string', description: 'Markdown content to parse (e.g. from milestone_export)' },
      },
      required: ['markdown'],
    },
  },
  {
    name: 'milestone_import_apply',
    description: 'Import a parsed milestone into a project — creates the milestone and all todos. Pass the ParsedMilestone from milestone_import_preview (or a manually crafted object). Returns { milestone, todos, warnings? }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Target project MongoDB ID' },
        parsed: {
          type: 'object',
          description: 'ParsedMilestone object (name, description?, todos[])',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            todos: { type: 'array' },
          },
          required: ['name', 'todos'],
        },
      },
      required: ['projectId', 'parsed'],
    },
  },
  {
    name: 'milestone_create_with_todos',
    description: 'Create a milestone with todos in one shot. Each todo SHOULD carry the structured Quest fields (userStories, acceptanceCriteria[{text, done?}], outOfScope, edgeCases, tags, priority) — only title is technically required, but when decomposing a spec or phase-plan a title-only backlog is wrong: transfer the source detail into the fields rather than discarding it. Intended for the Briefing-Mode flow where the agent has interactively gathered structured requirements with the user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Milestone name' },
        description: { type: 'string', description: 'Optional milestone description (markdown)' },
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
              tags: { type: 'array', items: { type: 'string' } },
              userStories: { type: 'string' },
              acceptanceCriteria: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    done: { type: 'boolean' },
                  },
                  required: ['text'],
                },
              },
              outOfScope: { type: 'string' },
              edgeCases: { type: 'string' },
            },
            required: ['title'],
          },
        },
      },
      required: ['projectId', 'name', 'todos'],
    },
  },
  {
    name: 'milestone_ai_complete',
    description: 'Ask the configured Chat-LLM to evaluate all todos of a milestone based on a user-supplied work summary and suggest status updates. Does NOT write to the DB — returns structured suggestions the user can selectively apply. Requires a Chat LLM endpoint to be configured in Settings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Milestone MongoDB ID' },
        number: { type: 'string', description: 'Milestone number (e.g. "1" or "M-1") — requires projectId' },
        projectId: { type: 'string', description: 'Project ID (required when using number)' },
        summaryMarkdown: {
          type: 'string',
          description: 'Markdown-formatted summary of the work done so far (max 50 000 chars)',
          maxLength: 50000,
        },
      },
      required: ['summaryMarkdown'],
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
    name: 'user_list_active',
    description: 'List active DevGrimoire users for targeted ask_user questions. Returns only userId, username, role, and lastSeenAt. Use targetUsername with ask_user when possible.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        windowMinutes: { type: 'number', description: 'Activity window in minutes (default: 15, max: 120)' },
      },
    },
  },
  {
    name: 'ask_user',
    description: 'Ask users a question and wait for an answer. By default this is broadcast to every user with project access (T-393). Use targetUsername/targetUserId to address one specific user, targetRole to address every user with that role, or broadcast=true to make the broadcast intent explicit. Optionally pass escalationChain to walk through escalating audiences as deadlines lapse (e.g. first your lead dev, then all developers, then everyone). The question is shown in the DevGrimoire UI (via SSE + push notification). If todoId is provided, the question and answer are documented as a comment on the todo.\n\n**T-392 BEFORE ASKING:** call `question_search` (or `rag_search` with entity=question) first to find prior answered questions covering the same topic. If you find a strong match, prefer reusing that answer (cite it in your response or ask the user only for confirmation) rather than re-prompting them. Setting `checkSimilar:true` runs that search automatically and returns the top matches under `priorMatches` in the result — useful as a fail-safe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: { type: 'array', items: { type: 'string' }, description: 'Answer options (if omitted, user can type free text)' },
        context: { type: 'string', description: 'Additional context to help the user understand the question' },
        todoId: { type: 'string', description: 'Todo MongoDB ID to link the question to a task (question + answer will be documented as comment)' },
        projectId: { type: 'string', description: 'Project MongoDB ID (auto-derived from todoId if set)' },
        targetUsername: { type: 'string', description: 'Username to target. Takes precedence over targetUserId. Omit for broadcast.' },
        targetUserId: { type: 'string', description: 'User MongoDB ID to target. Omit for broadcast.' },
        targetRole: { type: 'string', description: 'Role to target (T-393). Every active user with this role and project access sees the question.', enum: ['admin', 'user'] },
        broadcast: { type: 'boolean', description: 'Explicit broadcast — every active user with project access sees the question. Default false. When neither user nor role nor broadcast is set, the question still surfaces for every project-scoped user (legacy implicit broadcast).' },
        customerId: { type: 'string', description: 'Customer scope (T-390). Mutually exclusive with projectId in practice.' },
        researchSessionId: { type: 'string', description: 'T-390: link the question back to a Research Session for traceability.' },
        chatSessionId: { type: 'string', description: 'T-390: link the question back to a Chat Session for traceability.' },
        milestoneId: { type: 'string', description: 'T-390: link the question to a Milestone (decision-level questions).' },
        checkSimilar: { type: 'boolean', description: 'T-392: when true, run question_search before creating and include the top matches under `priorMatches` in the result. Use this as a fail-safe — prefer calling question_search explicitly so you can decide BEFORE asking.' },
        timeoutSeconds: { type: 'number', description: 'How long to wait for an answer (default: 300, max: 600)' },
        escalationChain: {
          type: 'array',
          description: 'Optional T-393 escalation chain. Each step re-targets the question and arms a fresh deadline once the previous wait window lapses without an answer. Example: [{ "kind": "role", "role": "admin", "afterMs": 600000 }, { "kind": "broadcast", "afterMs": 1800000 }] — first wait 5 min on the initial target, then escalate to admins for 10 min, then broadcast for 30 min.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['user', 'role', 'broadcast'] },
              userId: { type: 'string', description: 'Required when kind = user' },
              role: { type: 'string', description: 'Required when kind = role' },
              afterMs: { type: 'number', description: 'Wait window for this step in milliseconds (min 10_000, max 3_600_000)' },
            },
            required: ['kind', 'afterMs'],
          },
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'question_list',
    description: 'List open or answered questions linked to a todo or project. Supports both directions: agent_to_user (classic ask_user — pending or expired-but-still-answerable) and user_to_agent (user-initiated follow-ups, including on completed todos). Use this to check for pending follow-ups before continuing work on a todo.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        todoId: { type: 'string', description: 'Filter by Todo MongoDB ID (single todo). Use this to find user follow-ups before resuming work on a task.' },
        projectId: { type: 'string', description: 'Filter by Project MongoDB ID' },
        direction: { type: 'string', enum: ['agent_to_user', 'user_to_agent'], description: 'Direction filter. Defaults to all directions.' },
        includeAnswered: { type: 'boolean', description: 'Include already-answered questions (default false — only open ones). Works for both todo-scoped and project-scoped queries.' },
        limit: { type: 'number', description: 'Max items (default 50, max 200)' },
      },
    },
  },
  {
    name: 'question_get',
    description: 'Get a single question by ID, including its current answer if any.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Question MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'question_answer',
    description: 'Answer a user-to-agent follow-up question on a todo (T-247). Use this when responding to a user-initiated follow-up question discovered via question_list with direction=user_to_agent. Marks the question answered, posts the answer as a comment on the linked todo, and emits a question.answered event.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Question MongoDB ID' },
        answer: { type: 'string', description: 'The answer text — markdown supported.' },
      },
      required: ['id', 'answer'],
    },
  },
  {
    name: 'question_convert_to_knowledge',
    description: 'Convert an answered Question into a Knowledge entry and create a bidirectional link between them. Use this to capture project decisions or clarifications from Q&A conversations as reusable project knowledge. The question must have status "answered". Returns 400 if the question is not yet answered or has already been converted (check existing knowledgeId). Returns the created Knowledge document.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        questionId: { type: 'string', description: 'Question MongoDB ID to convert' },
        topic: { type: 'string', description: 'Title/topic of the Knowledge entry (required)' },
        content: { type: 'string', description: 'Body text of the Knowledge entry. Defaults to "**Frage:** <question>\\n\\n**Antwort:** <answer>" if omitted.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to categorise the knowledge entry' },
        category: { type: 'string', description: 'Optional free-form category (e.g. "Decision", "Architecture", "Process")' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'Scope for the knowledge entry. Defaults to "project" if the question has a projectId, otherwise "global".' },
      },
      required: ['questionId', 'topic'],
    },
  },
  {
    name: 'question_search',
    description: 'T-392: Semantic search over previously ANSWERED questions and their responses. Use BEFORE calling ask_user to check whether the same (or a very similar) question has already been answered, so the agent can reuse the prior decision instead of bothering the user again. Returns matches with title (question), content (Q+A), scope and similarity score. Combine with question_get for the full record.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query (typically the question you are about to ask)' },
        projectId: { type: 'string', description: 'Restrict to this project' },
        customerId: { type: 'string', description: 'Restrict to this customer' },
        limit: { type: 'number', description: 'Max results (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'question_cancel',
    description: 'T-394: Cancel a pending or snoozed question (no answer needed anymore). Cancelled questions stay in the audit trail but are removed from the pending list and skipped by the escalation scheduler.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Question MongoDB ID' },
        reason: { type: 'string', description: 'Optional cancellation reason (audit trail)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'question_snooze',
    description: 'T-394: Defer a pending question until a future date. The scheduler wakes it up at snoozeUntil by flipping the status back to pending with a fresh wait window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Question MongoDB ID' },
        snoozeUntil: { type: 'string', description: 'ISO 8601 wake-up timestamp (must be in the future)' },
      },
      required: ['id', 'snoozeUntil'],
    },
  },
  {
    name: 'question_create_followup_todo',
    description: 'T-391: Derive a follow-up Todo from an answered question. The new Todo inherits the project/customer scope of the question and is linked back via Question.followupTodoId. Returns 400 if the question is not yet answered or a follow-up already exists.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Question MongoDB ID' },
        title: { type: 'string', description: 'Override the auto-generated title' },
        description: { type: 'string', description: 'Override the auto-generated description (Markdown supported)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Todo priority (default medium)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'question_mark_as_decision',
    description: 'T-391: Stamp an answered question as a structured decision in Knowledge. Creates a Knowledge entry with category="decision" capturing the decision, rationale and scope, and writes back Question.decisionKnowledgeId. Stronger semantic than question_convert_to_knowledge — use for binding architectural / governance choices.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Question MongoDB ID' },
        decision: { type: 'string', description: 'The decision text in one sentence (required)' },
        rationale: { type: 'string', description: 'Why this decision was made (optional)' },
        scope: { type: 'string', description: 'Where the decision applies (optional, e.g. "Frontend", "Mobile App", "All services")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for the decision' },
      },
      required: ['id', 'decision'],
    },
  },
  {
    name: 'environment_create',
    description: 'Create an environment (e.g. dev, staging, prod) with key-value variables. Belongs to either a project (projectId) or a customer (customerId) — exactly one of the two is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID for customer-scoped environments (mutually exclusive with projectId)' },
        name: { type: 'string', description: 'Environment name (e.g. dev, staging, prod)' },
        description: { type: 'string', description: 'Optional environment description' },
        host: { type: 'string', description: 'Optional host name or IP address' },
        port: { type: 'number', description: 'Optional port number' },
        user: { type: 'string', description: 'Optional login/deploy user' },
        url: { type: 'string', description: 'Optional public/admin URL' },
        variables: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] }, description: 'Key-value pairs for environment variables' },
        active: { type: 'boolean', description: 'Whether environment is active (default true)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'environment_list',
    description: 'List environments (compact: name, active, variableCount). Filter by projectId for project envs or customerId for customer-scoped envs. Use environment_get for full variables.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
      },
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
    description: 'Update an environment (name, description, server details, variables, active status)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Environment MongoDB ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        user: { type: 'string' },
        url: { type: 'string' },
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
    description: 'Create or update an encrypted secret. AES-256-GCM. Belongs to either a project (projectId) or a customer (customerId) — exactly one is required. Use environmentId to scope to a specific environment, or omit for owner-global secrets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID for customer-scoped secrets (mutually exclusive with projectId)' },
        environmentId: { type: 'string', description: 'Environment MongoDB ID (optional, omit for owner-global)' },
        key: { type: 'string', description: 'Secret name (e.g. DB_PASSWORD, API_KEY)' },
        value: { type: 'string', description: 'Secret value (will be encrypted)' },
        description: { type: 'string', description: 'Optional description of the secret' },
        type: { type: 'string', enum: ['variable', 'password', 'token', 'ssh_key', 'certificate', 'file'], description: 'Secret type/category (default: variable)' },
      },
      required: ['key', 'value'],
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
    description: 'List secrets (keys and descriptions only, NO values). Filter by projectId for project secrets or customerId for customer-scoped secrets. Use secret_get to retrieve individual values.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        environmentId: { type: 'string', description: 'Filter by environment ID' },
      },
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
    description: 'Export all variables and decrypted secrets of an environment as key=value pairs (useful for .env file generation). Specify projectId or customerId to match the owner of the environment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        environmentId: { type: 'string', description: 'Environment MongoDB ID' },
        includeGlobalSecrets: { type: 'boolean', description: 'Include owner-global secrets (default true)' },
      },
      required: ['environmentId'],
    },
  },
  {
    name: 'manual_create',
    description: 'Create a new manual entry. Belongs to either a project (projectId) or a customer (customerId) — exactly one of the two is required. Manuals are categorized documentation pages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID for customer-scoped manual pages (mutually exclusive with projectId)' },
        title: { type: 'string', description: 'Entry title' },
        content: { type: 'string', description: 'Content in Markdown format' },
        category: { type: 'string', description: 'Category for grouping (e.g. Setup, API, Deployment)' },
        sortOrder: { type: 'number', description: 'Sort order within category (default 0)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'manual_list',
    description: 'List manual entries (compact: id, title, category, sortOrder, updatedAt). Filter by projectId for project manuals or customerId for customer-scoped manuals. Use manual_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        category: { type: 'string', description: 'Filter by category' },
      },
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
    description: 'Save a research entry (findings, analysis, comparisons). Scoped to either a project or a customer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        title: { type: 'string', description: 'Research title' },
        content: { type: 'string', description: 'Research content/findings' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Source URLs or references' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['title', 'content'],
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
        customerId: { type: 'string', description: 'Scope search to a specific customer' },
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
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
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
    name: 'research_topic_create',
    description: 'Create a scheduled autonomous research topic. A background agent runs on the configured schedule (or on-demand via research_topic_run), searches rag_search/web, and maintains a per-topic wiki of research artifacts. The owner is always the calling user (resolved from the MCP request context) — the scheduled agent later runs with that user\'s read scope/permissions, so it can never be impersonated via this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Topic title' },
        brief: { type: 'string', description: 'What the agent should research/maintain — its brief/mandate' },
        scope: {
          type: 'object',
          description: 'What the agent may read via rag_search. Defaults to mode=all (everything the owner can see).',
          properties: {
            mode: { type: 'string', enum: ['all', 'selected'] },
            projectIds: { type: 'array', items: { type: 'string' } },
            customerIds: { type: 'array', items: { type: 'string' } },
            includeGlobal: { type: 'boolean' },
          },
        },
        webSearch: {
          type: 'object',
          description: 'Whether the agent may use web search/fetch tools in addition to rag_search.',
          properties: {
            enabled: { type: 'boolean' },
            provider: { type: 'string' },
          },
        },
        schedule: {
          type: 'object',
          description: 'When the agent runs automatically.',
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
            hour: { type: 'number', description: '0-23' },
            dayOfWeek: { type: 'number', description: '0=Sun..6=Sat, for weekly/biweekly' },
            dayOfMonth: { type: 'number', description: '1-31, for monthly/quarterly/yearly' },
            month: { type: 'number', description: '1-12, for quarterly/yearly' },
            active: { type: 'boolean', description: 'Default true' },
          },
          required: ['frequency', 'hour'],
        },
        guardrails: {
          type: 'object',
          description: 'Per-run cost/safety bounds. Defaults: maxIterations=12, maxWebSearches=6, maxWebFetches=8, timeoutMs=300000.',
          properties: {
            maxIterations: { type: 'number' },
            maxWebSearches: { type: 'number' },
            maxWebFetches: { type: 'number' },
            timeoutMs: { type: 'number' },
          },
        },
        notifyOnComplete: { type: 'boolean', description: 'Send a notification when a run finishes' },
      },
      required: ['title', 'brief', 'schedule'],
    },
  },
  {
    name: 'research_topic_list',
    description: 'List research topics (compact: title, brief snippet, schedule status). Use research_topic_get for full detail.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        active: { type: 'boolean', description: 'Filter by schedule.active' },
        q: { type: 'string', description: 'Title substring filter' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
    },
  },
  {
    name: 'research_topic_get',
    description: 'Get a research topic by ID with full details (scope, schedule, guardrails).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ResearchTopic MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_topic_update',
    description: 'Update a research topic. Only supplied top-level fields change. When provided, "schedule" and "guardrails" are merged field-by-field with the existing values; "scope" and "webSearch", when provided, REPLACE the entire nested object (missing sub-fields fall back to defaults, not the existing value) — supply the full object for those two.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ResearchTopic MongoDB ID' },
        title: { type: 'string' },
        brief: { type: 'string' },
        scope: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['all', 'selected'] },
            projectIds: { type: 'array', items: { type: 'string' } },
            customerIds: { type: 'array', items: { type: 'string' } },
            includeGlobal: { type: 'boolean' },
          },
        },
        webSearch: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            provider: { type: 'string' },
          },
        },
        schedule: {
          type: 'object',
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
            hour: { type: 'number' },
            dayOfWeek: { type: 'number' },
            dayOfMonth: { type: 'number' },
            month: { type: 'number' },
            active: { type: 'boolean' },
          },
        },
        guardrails: {
          type: 'object',
          properties: {
            maxIterations: { type: 'number' },
            maxWebSearches: { type: 'number' },
            maxWebFetches: { type: 'number' },
            timeoutMs: { type: 'number' },
          },
        },
        notifyOnComplete: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_topic_delete',
    description: 'Delete a research topic and cascade-delete its artifacts, artifact versions, and runs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ResearchTopic MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_topic_run',
    description: 'Trigger a manual research run for a topic in the background. Returns immediately with the new run\'s id — the run itself keeps executing after this tool call returns. Poll research_run_get with that id for progress/completion.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ResearchTopic MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_run_list',
    description: 'List runs for a research topic (compact: status, trigger, timestamps, artifact counts — without the step-by-step audit trail). Use research_run_get for full detail including steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topicId: { type: 'string', description: 'ResearchTopic MongoDB ID' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['topicId'],
    },
  },
  {
    name: 'research_run_get',
    description: 'Get a research run by ID with full details, including its step-by-step tool-call audit trail.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ResearchRun MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'research_artifact_list',
    description: 'List artifacts (the research agent\'s per-topic wiki pages) for a topic (compact: slug, title, summary snippet, version). Use research_artifact_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topicId: { type: 'string', description: 'ResearchTopic MongoDB ID' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['topicId'],
    },
  },
  {
    name: 'research_artifact_get',
    description: 'Get a research artifact\'s full content by topic + slug.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topicId: { type: 'string', description: 'ResearchTopic MongoDB ID' },
        slug: { type: 'string', description: 'Artifact slug' },
      },
      required: ['topicId', 'slug'],
    },
  },
  {
    name: 'research_artifact_update',
    description: 'Create-or-fully-replace an artifact by topic + slug (upsert). This is a FULL overwrite of title/content/summary/tags/sources, not a partial patch — omitted tags/sources are cleared, not preserved. The previous version is snapshotted before being overwritten.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topicId: { type: 'string', description: 'ResearchTopic MongoDB ID' },
        slug: { type: 'string', description: 'Artifact slug (normalized to lowercase a-z0-9- automatically)' },
        title: { type: 'string' },
        content: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        sources: { type: 'array', items: { type: 'string' } },
        changeNote: { type: 'string', description: 'Note recorded on the snapshotted previous version' },
      },
      required: ['topicId', 'slug', 'title', 'content'],
    },
  },
  {
    name: 'research_artifact_delete',
    description: 'Delete an artifact and all its version snapshots.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topicId: { type: 'string', description: 'ResearchTopic MongoDB ID' },
        slug: { type: 'string', description: 'Artifact slug' },
      },
      required: ['topicId', 'slug'],
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
  {
    name: 'release_create',
    description: 'Create a release for a project. Supports manual releases and GitLab-synced releases.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        version: { type: 'string', description: 'Release version (e.g. 1.2.0)' },
        title: { type: 'string', description: 'Release title' },
        description: { type: 'string', description: 'Release notes (Markdown)' },
        releaseType: { type: 'string', enum: ['manual', 'gitlab'], description: 'Release type (default: manual)' },
        platform: { type: 'string', enum: ['android', 'ios', 'web', 'desktop', 'docker', 'other'], description: 'Target platform (default: other)' },
        status: { type: 'string', enum: ['draft', 'published', 'archived'], description: 'Release status (default: draft)' },
        downloadUrl: { type: 'string', description: 'Direct download URL' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        assets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, size: { type: 'number' }, format: { type: 'string' } }, required: ['name', 'url'] }, description: 'Release assets (binaries, links)' },
      },
      required: ['projectId', 'version'],
    },
  },
  {
    name: 'release_list',
    description: 'List project releases (compact: version, title, platform, status, releaseType, tags). Use release_get for full details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        status: { type: 'string', enum: ['draft', 'published', 'archived'], description: 'Filter by status' },
        platform: { type: 'string', enum: ['android', 'ios', 'web', 'desktop', 'docker', 'other'], description: 'Filter by platform' },
        releaseType: { type: 'string', enum: ['manual', 'gitlab'], description: 'Filter by release type' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'release_get',
    description: 'Get a single release with full details including description and assets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Release MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'release_update',
    description: 'Update a release (version, title, description, status, platform, assets, tags).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Release MongoDB ID' },
        version: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        releaseType: { type: 'string', enum: ['manual', 'gitlab'] },
        platform: { type: 'string', enum: ['android', 'ios', 'web', 'desktop', 'docker', 'other'] },
        status: { type: 'string', enum: ['draft', 'published', 'archived'] },
        downloadUrl: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        assets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, size: { type: 'number' }, format: { type: 'string' } }, required: ['name', 'url'] } },
      },
      required: ['id'],
    },
  },
  {
    name: 'release_delete',
    description: 'Delete a release.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Release MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'release_sync_gitlab',
    description: 'Sync releases from all configured git repositories (GitHub, GitLab, Gitea). Alias of release_sync — tool name kept for backwards compatibility, will be renamed in next release.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        repoIndex: { type: 'number', description: 'Optional: sync only specific repository by index (0-based)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'harness_get',
    description:
      "Get the harness for a project — the agreed way of working: process rules, bootstrap recipe, constraints. " +
      "Harnesses live on three levels that are merged in order global -> customer(s) -> project, so a project can extend a company-wide convention instead of restating it. " +
      "Without `raw` this returns the RESOLVED result: `sections[]` (already merged), `resolvedFrom[]` (which levels contributed), `suppressed[]` (sections a lower level switched off) and `markdown` (the rendered view to drop into context). " +
      "With `raw: true` plus a `scope` it returns that single level unchanged, which is what you want before editing. " +
      "A project without any harness yields an empty but well-formed result, not an error.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID — required unless raw is used with scope global/customer' },
        raw: { type: 'boolean', description: 'Return one unmerged level instead of the resolved result (default false)' },
        scope: { type: 'string', enum: [...HARNESS_SCOPES], description: 'Which level to return when raw is true' },
        customerId: { type: 'string', description: 'Customer MongoDB ID — required for raw reads with scope customer' },
      },
    },
  },
  {
    name: 'harness_list',
    description:
      'List existing harnesses — metadata only (scope, owner, section count, last change), never the section bodies. Use harness_get to read content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: [...HARNESS_SCOPES], description: 'Restrict to one level' },
      },
    },
  },
  {
    name: 'harness_section_set',
    description:
      "Create or update ONE section of a harness level, addressed by its `key`. Idempotent: the same input twice leaves the same state. " +
      "The level is created on first write, so you do not have to create the harness separately. " +
      "`mergeStrategy` decides what happens when a level below inherits this section: `replace` (default) overrides the inherited body, `append` adds to it, `prepend` puts this text first — the strategy of the INCOMING section wins, so a project can extend a company rule instead of only being able to overwrite it. " +
      "Set `enabled: false` to switch off a section inherited from a higher level without editing that level (a tombstone).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: [...HARNESS_SCOPES], description: 'Which level to write to' },
        projectId: { type: 'string', description: 'Required for scope project' },
        customerId: { type: 'string', description: 'Required for scope customer' },
        key: { type: 'string', description: 'kebab-case identifier, unique per level — this is the join key when levels are merged' },
        kind: { type: 'string', enum: [...HARNESS_SECTION_KINDS], description: "prose (rules/conventions) or bootstrap (session start recipe). block and constraint are reserved for later phases" },
        title: { type: 'string', description: 'Heading. Leave empty to inherit the title from the level above' },
        body: { type: 'string', description: 'Markdown content' },
        mergeStrategy: { type: 'string', enum: [...HARNESS_MERGE_STRATEGIES], description: 'How this section combines with an inherited one (default replace)' },
        order: { type: 'number', description: 'Sort order in the rendered result (default 0)' },
        enabled: { type: 'boolean', description: 'false tombstones an inherited section (default true)' },
      },
      required: ['scope', 'key'],
    },
  },
  {
    name: 'harness_section_delete',
    description:
      'Remove a section from one harness level. This removes it from that level only — a section inherited from a higher level comes back. To suppress an inherited section, use harness_section_set with enabled: false instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: [...HARNESS_SCOPES], description: 'Which level to remove from' },
        projectId: { type: 'string', description: 'Required for scope project' },
        customerId: { type: 'string', description: 'Required for scope customer' },
        key: { type: 'string', description: 'Section key to remove' },
      },
      required: ['scope', 'key'],
    },
  },
  {
    name: 'soul_get',
    description: 'Get a soul (identity, principles, conventions, boundaries) scoped to either a project or a customer. The soul defines how the agent should work with this owner. Returns an empty object if no soul is defined yet.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
      },
    },
  },
  {
    name: 'soul_update',
    description: 'Update (or create) a soul scoped to either a project or a customer. Supports partial updates — only provided sections are changed. Sections: vision, principles, conventions, communication, boundaries, workflow, quality.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        vision: { type: 'string', description: 'Vision, purpose, target audience' },
        principles: { type: 'string', description: 'Technical principles, architecture decisions' },
        conventions: { type: 'string', description: 'Coding style, naming, formatting, test requirements' },
        communication: { type: 'string', description: 'How the agent should communicate (verbose/concise, language, tone)' },
        boundaries: { type: 'string', description: 'What the agent should never do (no-gos)' },
        workflow: { type: 'string', description: 'How work should be done (plan first, review process, etc.)' },
        quality: { type: 'string', description: 'Quality standards, security requirements' },
      },
    },
  },
  // ─── Commits ───
  {
    name: 'commit_list',
    description: 'List commits for a project (compact: sha-short, first line of message, author, date, repoLabel). Synced from GitHub/GitLab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        branch: { type: 'string', description: 'Filter by branch name' },
        author: { type: 'string', description: 'Filter by author name or email (partial match)' },
        since: { type: 'string', description: 'Only commits after this ISO date' },
        until: { type: 'string', description: 'Only commits before this ISO date' },
        provider: { type: 'string', enum: ['github', 'gitlab'], description: 'Filter by provider' },
        repoLabel: { type: 'string', description: 'Filter by repository label (e.g. "API", "Frontend")' },
        limit: { type: 'number', description: 'Max items (default 20)' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'commit_search',
    description: 'Full-text search in commit messages for a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        query: { type: 'string', description: 'Search query for commit messages' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'commit_sync',
    description: 'Trigger manual sync of commits from configured Git repositories. Fetches new commits from GitHub/GitLab.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        repoIndex: { type: 'number', description: 'Optional: sync only a specific repository by index (0-based)' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'rag_search',
    description: 'Semantic search across all indexed content (knowledge, research, manuals, changelogs, todos, sessions, snippets, attachments, schemas). Uses vector embeddings for meaning-based search. Filter by project or customer scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        projectId: { type: 'string', description: 'Filter by project ID (project-scoped + global hits)' },
        customerId: { type: 'string', description: 'Filter by customer ID (customer-scoped + global hits)' },
        entity: { type: 'string', description: 'Filter by entity type: knowledge, research, manual, changelog, todo, session, snippet, attachment, schema' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'rag_reindex',
    description: 'Rebuild the RAG vector index. Run after initial setup or to fix sync issues. Can reindex all data, a specific project, or a specific customer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Reindex only this project (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Reindex only this customer (mutually exclusive with projectId)' },
      },
    },
  },
  {
    name: 'rag_status',
    description: 'Get RAG vector index statistics: readiness, embedding model, document count per entity type.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'web_search',
    description: 'Search the public web via the configured SearXNG instance. Returns title/url/snippet per hit. Read-only and cached. Intended for external research — for in-project search use rag_search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural-language search query' },
        language: { type: 'string', description: 'ISO 639-1 code, e.g. "de" or "en" (default from settings)' },
        categories: { type: 'array', items: { type: 'string', enum: ['general', 'news', 'science', 'it', 'files'] }, description: 'Restrict to these SearXNG categories' },
        timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Limit to results from the given time window' },
        limit: { type: 'number', description: 'Max results (1–20, default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and extract readable article text via Readability + DOMPurify. SSRF-protected (blocks private/loopback IPs). Use raw=true to get raw text without Readability (e.g. for plain-text files). Binary content (PDF, images) is rejected — use attachment_upload for those.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Public http:// or https:// URL to fetch' },
        raw: { type: 'boolean', description: 'Skip Readability and return raw text (default false)' },
        maxLength: { type: 'number', description: 'Truncate extracted text to N characters (default 50000, max 200000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'workspace_create',
    description: 'Create a code workspace bound to a project. The workspace is a sidecar-container scratch space for clone/pull/read/search operations. Name must be slug-compatible ([a-z0-9][a-z0-9_-]*, max 64) — it is used as a directory segment. The actual filesystem allocation happens lazily when the first operation runs against it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        name: { type: 'string', description: 'Workspace name — slug-compatible, unique per project' },
        description: { type: 'string', description: 'Optional description' },
        repoUrl: { type: 'string', description: 'Optional repository URL (can be set later)' },
        branch: { type: 'string', description: 'Branch to track (default "main")' },
        createdBySessionId: { type: 'string', description: 'Optional chat-session reference for traceability' },
        gitRepoId: { type: 'string', description: 'Optional: pin this workspace to one of the project.gitRepositories[]._id values. The matching token is then injected as GH_TOKEN/GITLAB_TOKEN+GITLAB_HOST per workspace_exec call. Default (omitted): first repo per provider wins.' },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: 'workspace_list',
    description: 'List workspaces of a project. Filter by status (active/archived/cleaning).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        status: { type: 'string', enum: ['active', 'archived', 'cleaning'], description: 'Optional status filter' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'workspace_get',
    description: 'Get a workspace by ID, or by projectId+name. Returns full document including path and lastActivityAt.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID (alternative to projectId+name)' },
        projectId: { type: 'string', description: 'Project MongoDB ID (use with name)' },
        name: { type: 'string', description: 'Workspace name (use with projectId)' },
      },
    },
  },
  {
    name: 'workspace_update',
    description: 'Update workspace metadata. Path stays bound to the workspace _id and is never reassigned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
        name: { type: 'string', description: 'New name (must stay slug-compatible)' },
        description: { type: 'string' },
        repoUrl: { type: 'string' },
        branch: { type: 'string' },
        gitRepoId: { type: 'string', description: 'Pin/repin to a different project.gitRepositories[]._id, or empty string to fall back to the first-wins default.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workspace_archive',
    description: 'Archive a workspace (sets status="archived"). Archived workspaces stay in the DB but are excluded from default listings and become eligible for the TTL garbage-collector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workspace_delete',
    description: 'Hard-delete a workspace including the entire clone on disk. The backend asks the user for confirmation via ask_user BEFORE deleting — the agent does not need to (and cannot bypass it). Returns {deleted:false, aborted:true, reason} on cancel/timeout. Use workspace_archive instead if you only want to hide the workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workspace_clone',
    description: 'Clone a git repository into the workspace volume. Shallow clone (depth=1) by default. Fails if the workspace already contains a repository — use workspace_pull instead. Does NOT install dependencies; the agent must request that explicitly via a future exec tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
        repoUrl: { type: 'string', description: 'http(s) git URL' },
        branch: { type: 'string', description: 'Optional branch to check out' },
      },
      required: ['id', 'repoUrl'],
    },
  },
  {
    name: 'workspace_pull',
    description: 'Fast-forward git pull on an existing workspace clone. Fails when the workspace has no .git or the merge is non-fast-forward.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workspace_tree',
    description: 'List the directory tree of a workspace as a flat array of {path,type}. Default depth=3, max 8. Skips .git. Truncates at 5000 entries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
        path: { type: 'string', description: 'Optional sub-path relative to workspace root (default ".")' },
        depth: { type: 'number', description: 'Recursion depth (1-8, default 3)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workspace_read',
    description: 'Read a single file from a workspace. UTF-8 only, max 5MB. Path must resolve inside the workspace root (../ escapes are rejected).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
        path: { type: 'string', description: 'File path relative to workspace root' },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'workspace_search',
    description: 'Run ripgrep across a workspace. Case-insensitive, max 50 matches per file, max 300 columns per line. Optional include/exclude globs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
        query: { type: 'string', description: 'Search pattern (ripgrep regex)' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob whitelist (e.g. ["*.ts","src/**"])',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional glob blacklist',
        },
      },
      required: ['id', 'query'],
    },
  },
  {
    name: 'workspace_status',
    description: 'Run git status --porcelain --branch on a workspace clone. Returns the raw porcelain output for programmatic parsing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workspace_exec',
    description: 'Execute a shell command inside the workspace sidecar. Sandboxed: runs as a non-root user in an isolated container with no access to DevGrimoire credentials, scrubbed environment (only PATH/HOME/USER/LANG/SHELL/TERM by default), per-call SIGTERM→SIGKILL timeout (default 60s, max 600s) and a regex blacklist for catastrophically dangerous patterns (rm -rf /, curl|sh, fork bombs). Output is capped at 1MB per stream. Use this for build/lint/test commands AFTER analysing the code with workspace_read/search — never as a first step. Audit-logged per call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
        command: { type: 'string', description: 'Shell command (executed under bash -lc, supports pipes/globbing). Max 8KB.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 60000, max 600000)' },
        env: {
          type: 'object',
          description: 'Optional caller-supplied env vars. Keys must match [A-Z_][A-Z0-9_]{0,63}, values <=4KB. Invalid entries are silently dropped.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['id', 'command'],
    },
  },
  {
    name: 'workspace_attachment_save',
    description: 'Copy a file from the workspace into the project Attachments (MinIO storage). The file is read binary-safe so zip/png/apk all work. Optionally link to an entity (todo/release/...) so it appears as that entity\'s attachment in the UI. Use this for build artefacts, test reports, screenshots, generated docs you want to keep beyond the workspace TTL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workspace MongoDB ID' },
        path: { type: 'string', description: 'File path relative to the workspace root (e.g. "dist/app.zip")' },
        fileName: { type: 'string', description: 'Optional override for the stored filename (default: basename of path)' },
        entityType: { type: 'string', description: 'Optional: link to entity type (e.g. "todo", "release")' },
        entityId: { type: 'string', description: 'Optional: linked entity MongoDB ID (requires entityType)' },
        description: { type: 'string', description: 'Optional human-readable description' },
        tags: {
          type: 'array',
          description: 'Optional tags (e.g. ["build", "v0.4.2"])',
          items: { type: 'string' },
        },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'ssh_connection_list',
    description: 'List SSH connections that have been configured in DevGrimoire for a customer or project. Scope is required (either projectId or customerId — no global discovery). Output contains host, port, username, authMethod, tags, status, lastConnectedAt — never credentials or host-key fingerprints. status: "ok" (lastConnectedAt set, no error), "error" (last connect failed), "fingerprint_pending" (TOFU not yet accepted in the UI), "never_tested" (fresh). When listing by projectId, the response also includes connections inherited from customers that are linked to the project — those entries carry `inheritedFromCustomerId` set to the owning customer\'s id and must be edited at the customer scope (the project may still ssh_exec / ssh_upload / ssh_download / ssh_list_files against them). Use this before ssh_exec/ssh_upload/ssh_download/ssh_list_files to discover available connections.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter (AND semantics: every tag must be present on the connection)' },
      },
    },
  },
  {
    name: 'ssh_connection_get',
    description: 'Get a single SSH connection by id OR slug+scope. Includes the latest audit row (action, sourceContext, exitCode, errorMsg). Never includes credentials or host-key fingerprints. Use this to confirm a connection is healthy (status=ok) before running ssh_exec against it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (kebab-case). Requires projectId or customerId to disambiguate scope.' },
        projectId: { type: 'string', description: 'Required with slug if the connection is project-scoped' },
        customerId: { type: 'string', description: 'Required with slug if the connection is customer-scoped' },
      },
    },
  },
  {
    name: 'ssh_exec',
    description: 'Execute a shell command on a remote server that was previously configured in DevGrimoire. Look up available connections with ssh_connection_list first. You never have direct access to SSH keys/passwords — they are resolved server-side. Stdout is truncated at 256 KB, stderr at 64 KB. Default timeout 60s, max 600s. The result includes stdoutBytes/stderrBytes/lastChunkAgeMs/aborted so you can recognise stalled vs. running commands. A no-output watchdog (`idleTimeoutMs`, default 30s) aborts commands that produce no stdout/stderr for that long — set 0 to disable (legacy behaviour) for legitimately quiet ops like `sleep 300 && echo done`. RECOMMENDED: split long multi-step pipelines (deploy / migrate / build) into separate ssh_exec calls of < 30s each; use `ssh_exec`-with-`tail -f` against an in-progress log file or poll a status command for long-running async work. Audit-logged with sourceContext="mcp". Connection lookup: connectionId wins; otherwise slug + (projectId|customerId).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (requires projectId or customerId)' },
        projectId: { type: 'string', description: 'Required with slug for project-scoped connections' },
        customerId: { type: 'string', description: 'Required with slug for customer-scoped connections' },
        command: { type: 'string', description: 'Shell command to execute on the remote (runs via ssh2.Client.exec, supports pipes/globbing on the remote shell).' },
        timeoutMs: { type: 'number', description: 'Absolute timeout in milliseconds (default 60000, max 600000). SIGTERM is sent first, then SIGKILL after a 5s grace. Aborts via this timer surface as `aborted: "timeout"` in the result.' },
        idleTimeoutMs: { type: 'number', description: 'No-output watchdog in milliseconds (default 30000, clamped to ≤ timeoutMs). The command is aborted with the same SIGTERM/SIGKILL escalation if no stdout or stderr byte arrives for this long — catches silent SSH hangs. Pass `0` to disable for commands that are legitimately quiet for long stretches. Aborts via this timer surface as `aborted: "idle"` in the result.' },
        env: { type: 'object', description: 'Optional environment variables forwarded to the remote command. Server-side may reject these if AcceptEnv is restrictive on the remote.', additionalProperties: { type: 'string' } },
        cwd: { type: 'string', description: 'Optional working directory on the remote. Wrapped as `cd \'...\' && <command>` with POSIX single-quote escaping.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ssh_upload',
    description: 'Write a file to a remote server via SFTP from content supplied inline. USE ONLY FOR CONTENT YOU AUTHOR YOURSELF — config files, scripts, patches, .env, unit files. For a file that already exists as bytes (tarball, zip, image, build artifact) use ssh_upload_from_workspace, ssh_upload_from_attachment, or the REST endpoint POST /api/ssh-connections/:id/upload instead. Reason: inline content has to be re-emitted token by token, and a single dropped or altered character in a base64 payload decodes SILENTLY into a corrupt remote file — no error, wrong bytes. Splitting a binary into smaller chunks does NOT help; it multiplies the risk. The practical ceiling here is the output-token budget (a few hundred KB at most), not the configured upload limit (default 10 MB, admin-configurable up to 500 MB, enforced on the decoded bytes). Use encoding="base64" for binary content (zips, images, etc.); otherwise utf-8 is assumed. Set createDirs=true to ensure parent directories exist (idempotent mkdir -p). Default file mode is 0o644. Pass sha256 whenever the bytes come from an existing file — the call then fails loudly instead of writing garbage, and the digest of what was written is always returned. If no workspace/attachment/REST route is available and you must move an existing file inline anyway, do it as VERIFIED CHUNKS: first call append=false with the sha256 of chunk 1, every following call append=true with the sha256 of that chunk; on checksum_mismatch re-send only the failed chunk, and confirm the assembled file with `ssh_exec sha256sum <remotePath>` at the end. Send chunks strictly one at a time — parallel appends to the same remotePath interleave and corrupt the result. Connection lookup is identical to ssh_exec: connectionId wins; otherwise slug + (projectId|customerId).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (requires projectId or customerId)' },
        projectId: { type: 'string', description: 'Required with slug for project-scoped connections' },
        customerId: { type: 'string', description: 'Required with slug for customer-scoped connections' },
        remotePath: { type: 'string', description: 'Absolute path on the remote where the file will be written' },
        content: { type: 'string', description: 'File content. For encoding="utf-8" send the raw text; for encoding="base64" send the base64-encoded bytes (line breaks are tolerated; any other stray character is rejected).' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'How `content` is encoded. Default "utf-8". Use "base64" for binary.' },
        mode: { type: 'number', description: 'File permission bits as a decimal number (e.g. 420 for 0o644, 493 for 0o755). Default 420.' },
        createDirs: { type: 'boolean', description: 'When true, mkdir -p the parent directories before writing. Default false.' },
        sha256: { type: 'string', description: 'Expected sha256 (hex) of the DECODED bytes — of this chunk when append=true, of the whole file otherwise. Verified before anything is written: on mismatch the call fails with checksum_mismatch and the remote file is left untouched. Always send this when the content came from an existing file.' },
        append: { type: 'boolean', description: 'When true, append to the remote file instead of overwriting it (creates it if absent). Default false. The upload limit is then enforced against the resulting total size, not the chunk.' },
      },
      required: ['remotePath', 'content'],
    },
  },
  {
    name: 'ssh_upload_from_attachment',
    description: 'Stream an existing attachment (stored in MinIO) to a remote server via SFTP, without buffering it in memory. Subject to the connection\'s configured upload limit (up to 500 MB). Requires MinIO to be configured. Connection lookup is identical to ssh_upload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (requires projectId or customerId)' },
        projectId: { type: 'string', description: 'Required with slug for project-scoped connections' },
        customerId: { type: 'string', description: 'Required with slug for customer-scoped connections' },
        attachmentId: { type: 'string', description: 'Attachment MongoDB ID to stream from MinIO' },
        remotePath: { type: 'string', description: 'Absolute path on the remote where the file will be written' },
        mode: { type: 'number', description: 'File permission bits as a decimal number (e.g. 420 for 0o644). Default 420.' },
        createDirs: { type: 'boolean', description: 'When true, mkdir -p the parent directories before writing. Default false.' },
      },
      required: ['attachmentId', 'remotePath'],
    },
  },
  {
    name: 'ssh_upload_from_workspace',
    description: 'Stream a file from a DevGrimoire workspace to a remote server via SFTP, without buffering it in memory. Ideal for deploying build artifacts. Subject to the connection\'s configured upload limit (up to 500 MB). Connection lookup is identical to ssh_upload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (requires projectId or customerId)' },
        projectId: { type: 'string', description: 'Required with slug for project-scoped connections' },
        customerId: { type: 'string', description: 'Required with slug for customer-scoped connections' },
        workspaceId: { type: 'string', description: 'Workspace MongoDB ID to read the source file from' },
        sourcePath: { type: 'string', description: 'Path of the file inside the workspace (relative to the workspace root)' },
        remotePath: { type: 'string', description: 'Absolute path on the remote where the file will be written' },
        mode: { type: 'number', description: 'File permission bits as a decimal number (e.g. 420 for 0o644). Default 420.' },
        createDirs: { type: 'boolean', description: 'When true, mkdir -p the parent directories before writing. Default false.' },
      },
      required: ['workspaceId', 'sourcePath', 'remotePath'],
    },
  },
  {
    name: 'ssh_download',
    description: 'Download a file from a remote server via SFTP. Default cap is 1 MB; pass maxBytes to raise it (hard limit 10 MB). Encoding is "utf-8" by default; the tool auto-switches to "base64" if the bytes contain null bytes or aren\'t round-trip-safe as UTF-8. truncated=true means the file was larger than maxBytes and only the prefix is returned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (requires projectId or customerId)' },
        projectId: { type: 'string', description: 'Required with slug for project-scoped connections' },
        customerId: { type: 'string', description: 'Required with slug for customer-scoped connections' },
        remotePath: { type: 'string', description: 'Absolute path on the remote to read' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read (default 1048576 = 1 MB, max 10485760 = 10 MB)' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Desired encoding. Default "utf-8"; auto-switches to "base64" for binary content.' },
      },
      required: ['remotePath'],
    },
  },
  {
    name: 'ssh_list_files',
    description: 'List files in a directory on a remote server via SFTP. Default 200 entries (max 2000). recursive=true walks subdirectories (depth-capped to 10). entries[].type is "file"|"dir"|"symlink", mode is the raw POSIX bits, mtime is an ISO timestamp.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (requires projectId or customerId)' },
        projectId: { type: 'string', description: 'Required with slug for project-scoped connections' },
        customerId: { type: 'string', description: 'Required with slug for customer-scoped connections' },
        remotePath: { type: 'string', description: 'Absolute directory path on the remote' },
        recursive: { type: 'boolean', description: 'When true, recurse into subdirectories (max depth 10). Default false.' },
        maxEntries: { type: 'number', description: 'Maximum number of entries to return (default 200, max 2000).' },
      },
      required: ['remotePath'],
    },
  },
  {
    name: 'ssh_exec_async',
    description: 'Start a shell command on a remote server in the BACKGROUND and return a jobId immediately. Use this for long-running operations (deploys, backups, multi-step pipelines) that would block a single ssh_exec call. Same connection-lookup, command, env, cwd, timeoutMs, idleTimeoutMs as ssh_exec — the only difference is that the response returns *before* the command finishes. Poll the result with ssh_exec_status (or interrupt with ssh_exec_cancel). The job is held in-memory for 10 minutes after it finishes, after which ssh_exec_status returns job_not_found. Backend restart drops in-flight jobs (audit row is still written on finalize). The async job still counts against the per-connection concurrency limit of 5.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        connectionId: { type: 'string', description: 'SshConnection MongoDB ID — wins if given' },
        slug: { type: 'string', description: 'SshConnection slug (requires projectId or customerId)' },
        projectId: { type: 'string', description: 'Required with slug for project-scoped connections' },
        customerId: { type: 'string', description: 'Required with slug for customer-scoped connections' },
        command: { type: 'string', description: 'Shell command to execute on the remote.' },
        timeoutMs: { type: 'number', description: 'Absolute timeout in milliseconds (default 60000, max 600000). Aborts surface as `aborted: "timeout"` in the status snapshot.' },
        idleTimeoutMs: { type: 'number', description: 'No-output watchdog (default 30000, ≤ timeoutMs, 0 = disabled). Aborts surface as `aborted: "idle"`.' },
        env: { type: 'object', description: 'Optional environment variables forwarded to the remote command.', additionalProperties: { type: 'string' } },
        cwd: { type: 'string', description: 'Optional working directory on the remote (wrapped as `cd \'...\' && <command>` with POSIX single-quote escaping).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ssh_exec_status',
    description: 'Poll an async exec job by jobId. Returns live progress (`state: running` with stdoutBytes/stderrBytes/lastChunkAgeMs/stdoutTail/stderrTail) and the terminal snapshot once done. Tail snippets are the *last 4 KB* of stdout and *last 2 KB* of stderr respectively, utf-8 rendered (invalid bytes become U+FFFD — for binary payloads use ssh_download). `state` is "running" until finalize, then "done" (clean exit, may still be non-zero exitCode) or "aborted" (escalation via timeout/idle/cancelled or remote signal). The job entry is reaped 10 minutes after finalize; later polls return job_not_found.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        jobId: { type: 'string', description: 'The jobId returned by ssh_exec_async.' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'ssh_exec_cancel',
    description: 'Cancel an async exec job by jobId. Triggers the SIGTERM→SIGKILL escalation pipeline (same as timeoutMs/idleTimeoutMs aborts) and returns the current status snapshot. Idempotent — cancelling a done/aborted job is a no-op and returns the existing status. Returns job_not_found for unknown or already-reaped jobIds.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        jobId: { type: 'string', description: 'The jobId returned by ssh_exec_async.' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'recurring_task_create',
    description: 'Create a recurring task. With projectId: creates project todos. With customerId: creates customer-scoped quests. With neither: system-wide task that creates notifications.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId; omit both for system-wide)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        title: { type: 'string', description: 'Todo/notification title' },
        description: { type: 'string', description: 'Description' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        milestoneId: { type: 'string', description: 'Milestone MongoDB ID' },
        repoLabel: { type: 'string', description: 'Repository label' },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'], description: 'How often to run' },
        dayOfWeek: { type: 'number', description: '0=Sun, 1=Mon, ..., 6=Sat (for weekly/biweekly)' },
        dayOfMonth: { type: 'number', description: '1-31 (for monthly/quarterly/yearly)' },
        month: { type: 'number', description: '1-12 (for quarterly/yearly)' },
        hour: { type: 'number', description: '0-23, default 9' },
        maxCatchUp: { type: 'number', description: 'Max catch-up runs after downtime (default 3)' },
      },
      required: ['title', 'frequency'],
    },
  },
  {
    name: 'recurring_task_list',
    description: 'List recurring tasks. Filter by projectId or customerId, or use systemOnly=true for system-wide tasks, or omit all for everything.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (optional)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (optional)' },
        systemOnly: { type: 'boolean', description: 'Only system-wide tasks (no projectId/customerId)' },
        active: { type: 'boolean', description: 'Filter by active/inactive' },
      },
    },
  },
  {
    name: 'recurring_task_get',
    description: 'Get a recurring task by ID with full details',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'RecurringTask MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'recurring_task_update',
    description: 'Update a recurring task',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'RecurringTask MongoDB ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        milestoneId: { type: 'string' },
        repoLabel: { type: 'string' },
        frequency: { type: 'string', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
        dayOfWeek: { type: 'number' },
        dayOfMonth: { type: 'number' },
        month: { type: 'number' },
        hour: { type: 'number' },
        active: { type: 'boolean' },
        maxCatchUp: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'recurring_task_delete',
    description: 'Delete a recurring task',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'RecurringTask MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'validation_report_add',
    description: 'Store a structured validation/test/build/lint result. Logs are masked and truncated server-side before persistence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        todoId: { type: 'string' },
        commitId: { type: 'string' },
        workflowRunId: { type: 'string' },
        name: { type: 'string', description: 'Short label, e.g. npm run build' },
        command: { type: 'string' },
        status: { type: 'string', enum: ['passed', 'failed', 'error', 'skipped'] },
        exitCode: { type: 'number' },
        durationMs: { type: 'number' },
        summary: { type: 'string' },
        outputSnippet: { type: 'string', description: 'Compact stdout/stderr excerpt; secrets are masked server-side' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
      },
      required: ['projectId', 'name', 'status'],
    },
  },
  {
    name: 'validation_report_list',
    description: 'List recent validation reports by project, todo, commit, workflowRun, or status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        todoId: { type: 'string' },
        commitId: { type: 'string' },
        workflowRunId: { type: 'string' },
        status: { type: 'string', enum: ['passed', 'failed', 'error', 'skipped'] },
        limit: { type: 'number', description: 'Default 50, max 200' },
      },
    },
  },
  {
    name: 'validation_report_get',
    description: 'Get one validation report by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'validation_report_propose_bug_todo',
    description: 'Create a reviewable bug-todo proposal from a failed/error validation report. Idempotent: returns the existing todo if one was already created for this report. Status open, priority defaults to high. Report metadata is updated with the new todo id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ValidationReport ID' },
        title: { type: 'string', description: 'Override todo title (defaults to "Bug: <report name>")' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Default high' },
        milestoneId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Default ["bug", "validation"]' },
      },
      required: ['id'],
    },
  },
  {
    name: 'doc_update_proposal_list',
    description: 'List reviewable documentation update proposals (Living Documentation). Filter by project, status, source, or target.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        status: { type: 'string', enum: ['open', 'accepted', 'edited', 'converted_to_todo', 'dismissed', 'superseded'] },
        sourceType: { type: 'string', enum: ['todo', 'commit', 'release', 'workflow_run', 'manual'] },
        sourceId: { type: 'string' },
        targetType: { type: 'string', enum: ['doc_file', 'knowledge', 'manual'] },
        targetId: { type: 'string' },
        limit: { type: 'number', description: 'Default 50, max 200' },
      },
    },
  },
  {
    name: 'doc_update_proposal_get',
    description: 'Get one documentation update proposal by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'doc_update_proposal_create',
    description: 'Create a documentation update proposal manually. Detection normally runs on todo review/done transitions; use this for agent-authored proposals. Duplicate open proposals for the same source+target are returned instead of recreated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        source: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['todo', 'commit', 'release', 'workflow_run', 'manual'] },
            id: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            changedFiles: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'id', 'summary'],
        },
        target: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['doc_file', 'knowledge', 'manual'] },
            id: { type: 'string', description: 'Mongo ObjectId for knowledge/manual targets' },
            path: { type: 'string', description: 'File path for doc_file targets' },
            title: { type: 'string' },
          },
          required: ['type', 'title'],
        },
        reason: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 10 },
        suggestedChange: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['patch', 'instructions', 'new_section', 'review_only'] },
            summary: { type: 'string' },
            diff: { type: 'string' },
            instructions: { type: 'string' },
          },
          required: ['mode', 'summary'],
        },
        createdBy: { type: 'string', enum: ['system', 'agent', 'user'] },
        metadata: { type: 'object' },
      },
      required: ['projectId', 'source', 'target', 'reason', 'confidence', 'suggestedChange'],
    },
  },
  {
    name: 'doc_update_proposal_update_status',
    description: 'Transition a proposal status: open → accepted/edited/converted_to_todo/dismissed; accepted ↔ edited; dismissed → open. Other transitions are rejected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'accepted', 'edited', 'converted_to_todo', 'dismissed', 'superseded'] },
        note: { type: 'string' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'doc_update_proposal_convert_to_todo',
    description: 'Convert an open proposal into a follow-up todo and mark it converted. Idempotent: returns the existing todo if one was already created.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        milestoneId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_graph_neighbors',
    description: 'List direct neighbors of an entity in the project knowledge graph. Returns edges where the entity appears as source or target.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        entityType: { type: 'string', enum: [...KG_ENTITY_TYPES] },
        entityId: { type: 'string' },
      },
      required: ['projectId', 'entityType', 'entityId'],
    },
  },
  {
    name: 'knowledge_graph_impact',
    description: 'Breadth-first traversal from a focal entity up to a given depth (1-5, default 2). Returns reachable entities with their depth plus the edges visited. Useful for "what could break if X changes?".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        entityType: { type: 'string', enum: [...KG_ENTITY_TYPES] },
        entityId: { type: 'string' },
        depth: { type: 'number', minimum: 1, maximum: 5 },
      },
      required: ['projectId', 'entityType', 'entityId'],
    },
  },
  {
    name: 'knowledge_graph_link',
    description: 'Create a user/agent-authored edge in the knowledge graph. Returns existing edge if a duplicate would be created.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        source: {
          type: 'object',
          properties: {
            entityType: { type: 'string', enum: [...KG_ENTITY_TYPES] },
            entityId: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['entityType', 'entityId'],
        },
        target: {
          type: 'object',
          properties: {
            entityType: { type: 'string', enum: [...KG_ENTITY_TYPES] },
            entityId: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['entityType', 'entityId'],
        },
        relation: { type: 'string', enum: [...KG_RELATIONS] },
        weight: { type: 'number', minimum: 0, maximum: 10 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        direction: { type: 'string', enum: ['directed', 'undirected'] },
        createdBy: { type: 'string', enum: ['system', 'agent', 'user'] },
        metadata: { type: 'object' },
      },
      required: ['projectId', 'source', 'target', 'relation'],
    },
  },
  {
    name: 'knowledge_graph_discover',
    description: 'Re-scan all entities of a project and (re)build deterministic edges. Returns counts of discovered, inserted and pruned edges. Edges marked userConfirmed=true are preserved.',
    inputSchema: {
      type: 'object' as const,
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'knowledge_graph_list',
    description: 'List edges in the project knowledge graph. Filter by entity (returns edges touching it) and/or relation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        entityType: { type: 'string', enum: [...KG_ENTITY_TYPES] },
        entityId: { type: 'string' },
        relation: { type: 'string', enum: [...KG_RELATIONS] },
        limit: { type: 'number', description: 'Default 500, max 5000' },
      },
    },
  },
  {
    name: 'oracle_analyze',
    description: 'Run the Oracle risk-analysis pipeline against a project. Detects stagnant todos, milestone deadline pressure, validation-failure hotspots and long blocker chains. Suggestions are persisted and deduped by fingerprint; previously-open ones that are no longer detected get marked as "addressed".',
    inputSchema: {
      type: 'object' as const,
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'oracle_list',
    description: 'List Oracle risk suggestions, sorted by severity (critical → warn → info) and recency. Filter by project, status, severity, or risk type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string' },
        status: { type: 'string', enum: ['open', 'dismissed', 'converted_to_todo', 'addressed'] },
        severity: { type: 'string', enum: ['info', 'warn', 'critical'] },
        type: { type: 'string', enum: ['stagnation', 'deadline_pressure', 'bug_hotspot', 'blocker_chain'] },
        limit: { type: 'number', description: 'Default 100, max 1000' },
      },
    },
  },
  {
    name: 'oracle_get',
    description: 'Get one Oracle suggestion by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'oracle_update_status',
    description: 'Transition an Oracle suggestion: open → dismissed/converted_to_todo/addressed. Use to mark a risk as resolved by the user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'dismissed', 'converted_to_todo', 'addressed'] },
        note: { type: 'string' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'oracle_convert_to_todo',
    description: 'Convert an open Oracle suggestion into a follow-up todo and mark it converted. Idempotent: returns the existing todo if one was already created. Priority defaults to high for critical suggestions, medium otherwise.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        milestoneId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'oracle_comment_on_todo',
    description: 'Write an Oracle suggestion as a comment on an affected todo, or on an explicit todoId, then mark the suggestion addressed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        todoId: { type: 'string', description: 'Optional explicit target todo. Defaults to first affected todo.' },
        note: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_create',
    description: 'Create a workflow definition (graph of triggers, nodes and edges). Scope controls visibility: system (admin-only), project (requires projectId), customer (requires customerId).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: ['system', 'project', 'customer'] },
        projectId: { type: 'string', description: 'Required for project scope' },
        customerId: { type: 'string', description: 'Required for customer scope' },
        name: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        trigger: { type: 'object', description: 'Trigger config; default { type: "manual" }' },
        nodes: { type: 'array', description: 'WorkflowNode[] (id, type, position, config, secretRefs, ...)' },
        edges: { type: 'array', description: 'WorkflowEdge[] (id, source, target, branch, condition, ...)' },
        ui: { type: 'object', description: 'Canvas viewport/style metadata (non-runtime)' },
      },
      required: ['scope', 'name'],
    },
  },
  {
    name: 'workflow_list',
    description: 'List workflow definitions (compact: id, name, scope, status, version, tags, updatedAt). Archived definitions are excluded by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: ['system', 'project', 'customer'] },
        projectId: { type: 'string' },
        customerId: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'active', 'paused', 'archived'] },
        tag: { type: 'string' },
        includeArchived: { type: 'boolean' },
        limit: { type: 'number', description: 'Default 50' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'workflow_get',
    description: 'Get a workflow definition with full nodes/edges',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'workflow_update',
    description: 'Update a workflow. Editing nodes/edges/trigger on a non-draft workflow auto-increments version. Set publish=true to force a version bump.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'active', 'paused', 'archived'] },
        tags: { type: 'array', items: { type: 'string' } },
        trigger: { type: 'object' },
        nodes: { type: 'array' },
        edges: { type: 'array' },
        ui: { type: 'object' },
        publish: { type: 'boolean', description: 'Force a version bump on this update' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_delete',
    description: 'Delete a workflow definition and all its runs/node-runs',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'workflow_validate',
    description: 'Statically validate a workflow graph (scope consistency, orphan/dangling edges, duplicate ids, self-loops). Does NOT enforce node-type-specific config correctness. Pass either an existing workflow id OR a draft graph payload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Workflow id to validate (loads from DB)' },
        scope: { type: 'string', enum: ['system', 'project', 'customer'] },
        projectId: { type: 'string' },
        customerId: { type: 'string' },
        nodes: { type: 'array' },
        edges: { type: 'array' },
      },
    },
  },
  {
    name: 'workflow_run_start',
    description: 'Start a new run for a workflow definition. Run is created in `queued` status with a frozen snapshot of the current version. Execution engine (separate task) will pick up queued runs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        definitionId: { type: 'string' },
        trigger: { type: 'object', description: 'Trigger event payload (defaults to { type: "manual" })' },
        input: { type: 'object', description: 'Initial input payload (folded into trigger)' },
      },
      required: ['definitionId'],
    },
  },
  {
    name: 'workflow_run_list',
    description: 'List workflow runs (compact). Filter by definitionId, scope/ownership, or status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        definitionId: { type: 'string' },
        scope: { type: 'string', enum: ['system', 'project', 'customer'] },
        projectId: { type: 'string' },
        customerId: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'cancelled'] },
        limit: { type: 'number', description: 'Default 50' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'workflow_run_get',
    description: 'Get a workflow run with its frozen definition snapshot, status and current node ids',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'workflow_run_inspect',
    description: 'Inspect a workflow run for debugging. Returns run summary, node-run status counts, failed/waiting node ids, and masked/truncated per-node previews.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'workflow_run_cancel',
    description: 'Cancel a non-terminal workflow run. Sets status=cancelled with an error code and finishedAt.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_run_retry',
    description: 'Retry a failed or cancelled workflow run. Optionally starts from a specific node id; otherwise resumes at the first failed node, or the trigger if none.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        fromNodeId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_node_test',
    description: 'Safely test a single workflow node with sample input. Executes only side-effect-free trigger/control nodes; action and agent nodes are validation-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            label: { type: 'string' },
            position: { type: 'object' },
            config: { type: 'object' },
            secretRefs: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'type', 'position'],
        },
        scope: { type: 'string', enum: ['system', 'project', 'customer'] },
        input: { type: 'object' },
        runContext: { type: 'object' },
      },
      required: ['node'],
    },
  },
  {
    name: 'workflow_node_run_list',
    description: 'List the node runs for a workflow run, sorted by createdAt.',
    inputSchema: {
      type: 'object' as const,
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
  },
  {
    name: 'workflow_node_types_list',
    description: 'Returns the catalog of registered workflow node types with their JSON-Schema configs, outputs, scopes and branches. Read-only — used by UI and agents constructing workflows.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'customer_template_create',
    description: 'Create a customer setup template. Templates contain repeatable, NON-SECRET blueprints (todos, environments, monitoring checks, contacts, workflows). Secret values are rejected — use requiredSecretKeys for placeholders.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        slug: { type: 'string', description: 'lowercase + hyphens, unique' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['onboarding', 'todo_list', 'monitoring', 'environment', 'workflow', 'contact_type'] },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        items: { type: 'array', description: 'Array of CustomerTemplateItem (kind, title, description?, payload, requiredSecretKeys?, placeholders?)' },
      },
      required: ['name', 'slug', 'type'],
    },
  },
  {
    name: 'customer_template_list',
    description: 'List customer templates (compact). Filter by type, active, tag.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['onboarding', 'todo_list', 'monitoring', 'environment', 'workflow', 'contact_type'] },
        active: { type: 'boolean' },
        tag: { type: 'string' },
      },
    },
  },
  {
    name: 'customer_template_get',
    description: 'Get a customer template with all items',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'customer_template_update',
    description: 'Update a customer template. Editing items or type auto-bumps version.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['onboarding', 'todo_list', 'monitoring', 'environment', 'workflow', 'contact_type'] },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        items: { type: 'array' },
        publish: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'customer_template_delete',
    description: 'Delete a customer template (does NOT touch any entities created from past applies)',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'customer_template_preview',
    description: 'Dry-run: returns what would be created for the customer without persisting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Template id' },
        customerId: { type: 'string' },
      },
      required: ['id', 'customerId'],
    },
  },
  {
    name: 'customer_template_apply',
    description: 'Apply a template to a customer. Creates todos / environments / contacts / monitoring checks / customer-scoped workflows from items. Failed items are reported per-item, the apply does not fail the whole operation. Returns the created entities and any required-but-missing secret keys.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Template id' },
        customerId: { type: 'string' },
      },
      required: ['id', 'customerId'],
    },
  },
  {
    name: 'snippet_save',
    description: 'Save a code snippet. Scoped to either a project or a customer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        title: { type: 'string', description: 'Snippet title' },
        language: { type: 'string', description: 'Programming language (e.g. typescript, python, bash, sql)' },
        code: { type: 'string', description: 'The code snippet content' },
        description: { type: 'string', description: 'Optional description/explanation' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        category: { type: 'string', description: 'Category (e.g. Utils, Config, Patterns, Queries)' },
        fileName: { type: 'string', description: 'Optional source file name' },
      },
      required: ['title', 'language', 'code'],
    },
  },
  {
    name: 'snippet_list',
    description: 'List code snippets (compact: id, title, language, category, tags). Use snippet_get for full code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        language: { type: 'string', description: 'Filter by programming language' },
        category: { type: 'string', description: 'Filter by category' },
        tag: { type: 'string', description: 'Filter by tag (exact match)' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
    },
  },
  {
    name: 'snippet_get',
    description: 'Get a code snippet with full code content',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Snippet MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'snippet_update',
    description: 'Update a code snippet',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Snippet MongoDB ID' },
        title: { type: 'string', description: 'Snippet title' },
        language: { type: 'string', description: 'Programming language' },
        code: { type: 'string', description: 'The code snippet content' },
        description: { type: 'string', description: 'Description/explanation' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        category: { type: 'string', description: 'Category' },
        fileName: { type: 'string', description: 'Source file name' },
      },
      required: ['id'],
    },
  },
  {
    name: 'snippet_delete',
    description: 'Delete a code snippet',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Snippet MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'snippet_search',
    description: 'Full-text search over code snippets. Returns snippets (200 chars of code) — use snippet_get for full content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        q: { type: 'string', description: 'Search query' },
        projectId: { type: 'string', description: 'Optional: limit to project' },
        customerId: { type: 'string', description: 'Optional: limit to customer' },
      },
      required: ['q'],
    },
  },
  // ── Attachments ──────────────────────────────────────────────
  {
    name: 'attachment_upload',
    description: 'Upload a file attachment. Content must be base64-encoded. Belongs to either a project (projectId) or a customer (customerId) — exactly one of the two is required. Can attach to a specific entity (e.g. todo) or as standalone owner-scoped file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID for customer-scoped files (mutually exclusive with projectId)' },
        fileName: { type: 'string', description: 'Original filename (e.g. "diagram.png")' },
        content: { type: 'string', description: 'Base64-encoded file content' },
        mimeType: { type: 'string', description: 'MIME type (auto-detected from extension if omitted)' },
        entityType: { type: 'string', description: 'Entity type to attach to (e.g. "todo", "knowledge")' },
        entityId: { type: 'string', description: 'Entity MongoDB ID to attach to' },
        description: { type: 'string', description: 'Optional description' },
        tags: { type: 'string', description: 'Comma-separated tags' },
      },
      required: ['fileName', 'content'],
    },
  },
  {
    name: 'attachment_list',
    description: 'List file attachments. Filter by projectId for project files or customerId for customer-scoped files. Optionally filter by entity type/id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        entityType: { type: 'string', description: 'Filter by entity type (e.g. "todo")' },
        entityId: { type: 'string', description: 'Filter by entity MongoDB ID' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Skip results' },
      },
    },
  },
  {
    name: 'attachment_get',
    description: 'Get metadata of a single attachment (no file content).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Attachment MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'attachment_download',
    description: 'Download file content. Returns text directly for text files, base64 for binary files. Max 5MB.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Attachment MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'attachment_delete',
    description: 'Delete a file attachment (removes from storage and database).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Attachment MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'log_list',
    description: 'List application logs for a project. Logs are sent by external apps via API key and auto-deleted after 5 days. Filter by level, service, date range, or full-text search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Filter by log level' },
        service: { type: 'string', description: 'Filter by service name' },
        search: { type: 'string', description: 'Full-text search in message, service, area' },
        startDate: { type: 'string', description: 'Start date ISO string (e.g. 2026-04-01)' },
        endDate: { type: 'string', description: 'End date ISO string (e.g. 2026-04-07)' },
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
        offset: { type: 'number', description: 'Skip entries for pagination' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'log_search',
    description: 'Search application logs by full-text query. Returns matching log entries with message snippets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
        query: { type: 'string', description: 'Search query (full-text)' },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Filter by log level' },
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'log_stats',
    description: 'Get log statistics for a project: total count, breakdown by level and service, oldest/newest entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'chat_create',
    description: 'Create a new chat session scoped to either a project or a customer. Returns the session id which is needed for chat_send and chat_get.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        title: { type: 'string', description: 'Optional session title (default: timestamp)' },
      },
    },
  },
  {
    name: 'chat_list',
    description: 'List chat sessions of a project or customer (compact: id, title, message count, updatedAt). Use chat_get for full messages. Archived sessions are excluded by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project MongoDB ID (mutually exclusive with customerId)' },
        customerId: { type: 'string', description: 'Customer MongoDB ID (mutually exclusive with projectId)' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions (default false)' },
        limit: { type: 'number', description: 'Max items to return' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
    },
  },
  {
    name: 'chat_get',
    description: 'Get a chat session with all messages (role, content, contextUsed, toolCalls, timestamp).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Chat session MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'chat_send',
    description: 'Send a user message to a chat session and return the assistant response (non-streaming, blocks until complete). Both messages are persisted in the session. Tool-calling and the configured RAG context are applied just like in the web UI; tool-call iteration honors the global toolsMaxIterations setting. Note: this can take several seconds depending on the LLM endpoint.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Chat session MongoDB ID' },
        content: { type: 'string', description: 'User message text' },
      },
      required: ['sessionId', 'content'],
    },
  },
  {
    name: 'chat_delete',
    description: 'Delete a chat session and all its messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Chat session MongoDB ID' },
      },
      required: ['id'],
    },
  },
  // ---- Monitoring / Healthchecks --------------------------------------------
  {
    name: 'monitor_create',
    description: 'Create a healthcheck for a customer. Periodically pings an HTTP endpoint and tracks reachability. Sensitive header values must be supplied via secretHeaders (referencing existing Secret IDs), never as plain header values.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Owning customer MongoDB ID' },
        projectId: { type: 'string', description: 'Optional linked project' },
        customerProjectId: { type: 'string', description: 'Optional CustomerProjectLink ID' },
        environmentId: { type: 'string', description: 'Optional Environment ID this check belongs to' },
        name: { type: 'string', description: 'Display name (unique per customer)' },
        description: { type: 'string', description: 'Free text description' },
        method: { type: 'string', enum: ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string', description: 'Target URL incl. protocol' },
        headers: {
          type: 'array',
          description: 'Plain HTTP headers (no secret values).',
          items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name'] },
        },
        secretHeaders: {
          type: 'array',
          description: 'Headers whose value is resolved from a Secret at execution time.',
          items: { type: 'object', properties: { name: { type: 'string' }, secretId: { type: 'string' } }, required: ['name', 'secretId'] },
        },
        body: { type: 'string', description: 'Optional request body (used for POST/PUT/PATCH)' },
        contentType: { type: 'string', description: 'Content-Type header for the body (default application/json)' },
        intervalSeconds: { type: 'number', description: 'Interval between runs in seconds (min 60)' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (default 10000)' },
        expectedStatus: { type: 'array', items: { type: 'number' }, description: 'Allowed HTTP status codes; empty = any 2xx' },
        expectedContent: { type: 'string', description: 'Optional substring required in response body' },
        failureThreshold: { type: 'number', description: 'Consecutive failures required before flipping to UNHEALTHY (default 2)' },
        active: { type: 'boolean', description: 'Whether the scheduler runs this check (default true)' },
      },
      required: ['customerId', 'name', 'url'],
    },
  },
  {
    name: 'monitor_list',
    description: 'List healthchecks for a customer with current status, last run, latency and error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'monitor_get',
    description: 'Get a healthcheck with full configuration and current state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Healthcheck MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'monitor_update',
    description: 'Update a healthcheck. Pausing it (active=false) clears nextRunAt; reactivating triggers an immediate run.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Healthcheck MongoDB ID' },
        projectId: { type: 'string' },
        customerProjectId: { type: 'string' },
        environmentId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string' },
        headers: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name'] },
        },
        secretHeaders: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, secretId: { type: 'string' } }, required: ['name', 'secretId'] },
        },
        body: { type: 'string' },
        contentType: { type: 'string' },
        intervalSeconds: { type: 'number' },
        timeoutMs: { type: 'number' },
        expectedStatus: { type: 'array', items: { type: 'number' } },
        expectedContent: { type: 'string' },
        failureThreshold: { type: 'number' },
        active: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'monitor_delete',
    description: 'Delete a healthcheck and its history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Healthcheck MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'monitor_run',
    description: 'Run a healthcheck immediately and return the updated state. Performs an outbound HTTP request — treat as a write tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Healthcheck MongoDB ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'monitor_history',
    description: 'List recent run results for a healthcheck (status, statusCode, latency, error). History is auto-pruned after 30 days.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Healthcheck MongoDB ID' },
        limit: { type: 'number', description: 'Max items (default 50, max 500)' },
        offset: { type: 'number', description: 'Skip first N items' },
      },
      required: ['id'],
    },
  },
  {
    name: 'monitor_summary',
    description: 'Aggregated status across all healthchecks of a customer (counts by status + worst overall status).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customerId: { type: 'string', description: 'Customer MongoDB ID' },
      },
      required: ['customerId'],
    },
  },
  // ---- API-Werkbank / HTTP-Requests -----------------------------------------
  {
    name: 'request_collection_create',
    description: 'Create a named request collection inside a project (groups saved HTTP requests).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Owning project ID' },
        name: { type: 'string', description: 'Collection name' },
        description: { type: 'string' },
        order: { type: 'number' },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: 'request_collection_list',
    description: 'List request collections of a project.',
    inputSchema: {
      type: 'object' as const,
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'request_collection_update',
    description: 'Update a request collection (name/description/order).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' }, name: { type: 'string' },
        description: { type: 'string' }, order: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'request_collection_delete',
    description: 'Delete a request collection and all its requests and history.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'request_create',
    description: 'Create a saved HTTP request in a collection. URL, header values, query and body may contain {{key}} placeholders that resolve from the chosen environment (variables + secrets) at send time. Never store plaintext secrets — reference them as {{SECRET_KEY}}.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        collectionId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
        url: { type: 'string', description: 'Target URL, may contain {{placeholders}}' },
        queryParams: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['key'] } },
        headers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['name'] } },
        auth: { type: 'object', properties: { type: { type: 'string', enum: ['none', 'basic', 'bearer'] }, username: { type: 'string' }, password: { type: 'string' }, token: { type: 'string' } } },
        body: { type: 'object', properties: { mode: { type: 'string', enum: ['none', 'raw', 'form-urlencoded', 'multipart'] }, raw: { type: 'string' }, contentType: { type: 'string' }, formFields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['key'] } } } },
        timeoutMs: { type: 'number' },
        followRedirects: { type: 'boolean' },
      },
      required: ['collectionId', 'name', 'url'],
    },
  },
  {
    name: 'request_list',
    description: 'List saved requests of a collection or a whole project (metadata only).',
    inputSchema: {
      type: 'object' as const,
      properties: { collectionId: { type: 'string' }, projectId: { type: 'string' } },
    },
  },
  {
    name: 'request_get',
    description: 'Get a saved request with full configuration.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'request_update',
    description: 'Update a saved request. Same fields as request_create (all optional).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' }, description: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
        url: { type: 'string' },
        queryParams: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['key'] } },
        headers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['name'] } },
        auth: { type: 'object', properties: { type: { type: 'string', enum: ['none', 'basic', 'bearer'] }, username: { type: 'string' }, password: { type: 'string' }, token: { type: 'string' } } },
        body: { type: 'object', properties: { mode: { type: 'string', enum: ['none', 'raw', 'form-urlencoded', 'multipart'] }, raw: { type: 'string' }, contentType: { type: 'string' }, formFields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['key'] } } } },
        timeoutMs: { type: 'number' },
        followRedirects: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'request_delete',
    description: 'Delete a saved request and its history.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'request_send',
    description: 'Send a saved request via the backend proxy and return status, timing and a truncated response body. Resolves {{placeholders}} server-side from the chosen environment; secrets are never returned in plaintext beyond the live response you triggered. Performs an outbound HTTP request — treat as a write tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Saved request ID' },
        environmentId: { type: 'string', description: 'Optional environment whose variables + secrets fill the placeholders' },
      },
      required: ['id'],
    },
  },
  {
    name: 'request_history_list',
    description: 'List recent send results for a saved request (secret values are masked). Auto-pruned after 30 days.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'request_history_get',
    description: 'Get a single send-history entry (masked request snapshot + response).',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'request_import_curl',
    description: 'Parse a curl command and create a saved request from it in the given collection. Imports values verbatim (does not auto-detect secrets).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        collectionId: { type: 'string' },
        curl: { type: 'string', description: 'The curl command text' },
        name: { type: 'string', description: 'Optional name; defaults to "METHOD url"' },
      },
      required: ['collectionId', 'curl'],
    },
  },
];

function isToolAllowed(toolName: string): boolean {
  const apiKey = RequestContext.getApiKey();
  if (!apiKey) return true;
  if (!Array.isArray(apiKey.allowedTools)) return true;
  return apiKey.allowedTools.includes(toolName);
}

export function toolGroup(name: string): 'Task-Management' | 'Wissen & Suche' | 'External-Read' | 'Kundenverwaltung' | 'Projekt-Daten' {
  if (
    name.startsWith('todo_') ||
    name.startsWith('milestone_') ||
    name.startsWith('recurring_task_') ||
    name.startsWith('validation_report_') ||
    name.startsWith('doc_update_proposal_') ||
    name.startsWith('knowledge_graph_') ||
    name.startsWith('oracle_') ||
    name.startsWith('workflow_') ||
    name.startsWith('question_')
  ) {
    return 'Task-Management';
  }
  if (
    name.startsWith('knowledge_') ||
    name.startsWith('session_') ||
    name.startsWith('changelog_') ||
    name.startsWith('research_') ||
    name.startsWith('manual_') ||
    name.startsWith('snippet_') ||
    name.startsWith('rag_') ||
    name.startsWith('chat_')
  ) {
    return 'Wissen & Suche';
  }
  if (name.startsWith('web_')) {
    return 'External-Read';
  }
  if (
    name.startsWith('customer_') ||
    name.startsWith('contact_') ||
    name.startsWith('monitor_') ||
    name === 'project_customer_links'
  ) {
    return 'Kundenverwaltung';
  }
  return 'Projekt-Daten';
}

export interface McpToolCatalogEntry {
  name: string;
  description: string;
  group: ReturnType<typeof toolGroup>;
  isWrite: boolean;
}

const WRITE_TOOL_SUFFIX = /_(create|update|delete|save|set|add|comment|archive|sync|scan|reindex|clone|pull|exec|upload|send)$/;

const SENSITIVE_READ_TOOLS = new Set<string>([
  'secret_get',
  'environment_export',
]);

const EXPLICIT_WRITE_TOOLS = new Set<string>([
  'release_sync_gitlab',
  'workspace_attachment_save',
  'monitor_run',
  'research_topic_run',
  'workflow_run_start',
  'workflow_run_cancel',
  'workflow_run_retry',
  'oracle_comment_on_todo',
  'customer_template_apply',
  'todo_ask_question',
  'question_convert_to_knowledge',
  'milestone_import_apply',
  'milestone_create_with_todos',
  'request_import_curl',
  'stack_entry_remove',
]);

export function isWriteTool(name: string): boolean {
  if (EXPLICIT_WRITE_TOOLS.has(name)) return true;
  if (SENSITIVE_READ_TOOLS.has(name)) return true;
  return WRITE_TOOL_SUFFIX.test(name);
}

export function getToolCatalog(): McpToolCatalogEntry[] {
  return tools
    .map((t) => ({
      name: t.name,
      description: (t as { description?: string }).description ?? '',
      group: toolGroup(t.name),
      isWrite: isWriteTool(t.name),
    }))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      if (a.isWrite !== b.isWrite) return a.isWrite ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}

export function registerMcpTools(server: Server, services: McpServices): void {
  const { projectsService, todosService, sessionsService, knowledgeService, changelogService, milestonesService, activitiesService, environmentsService, secretsService, manualsService, researchService, researchTopicService, researchRunService, researchArtifactService, researchAgentService, settingsService, notificationsService, schemasService, dependenciesService, featuresService, soulsService, harnessService, commitsService, ragService, recurringTasksService, workflowsService, workflowEngineService, nodeRegistry, customerTemplatesService, validationReportsService, docUpdateProposalsService, knowledgeGraphService, oracleService, snippetsService, attachmentsService, questionsService, authService, customersService, contactsService, monitoringService, logsService, releasesService, chatService, chatLlmService, chatContextService, webSearchService, readabilityService, workspacesService, workspaceClient, workspaceGitTokens, workspaceCliToken, sshService, sshSessionService, httpRequestsService, stackService } = services;

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const filteredTools = tools.filter((t) => isToolAllowed(t.name));
    return { tools: filteredTools };
  });

  // M-35: MCP Apps Extension (io.modelcontextprotocol/ui).
  //
  // We always advertise UI-resources unconditionally. Hosts that do not
  // implement the Apps extension simply never call `resources/read` for
  // the `ui://` URIs and ignore the `_meta.ui.resourceUri` annotation on
  // tools — fallback to the classic JSON tool result is automatic.
  // See docs/mcp-apps.md for the full mapping and security model.
  server.setRequestHandler(ListResourcesRequestSchema, () => {
    return {
      resources: UI_RESOURCES.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const uri = req.params?.uri as string | undefined;
    if (!uri) throw new Error('resources/read requires a uri parameter');
    const resource = findUiResource(uri);
    if (!resource) throw new Error(`Unknown resource: ${uri}`);
    return {
      contents: [{
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.html,
        _meta: resource.meta ? { ui: resource.meta } : undefined,
      }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    
    if (!isToolAllowed(name)) {
      return errorResult(`Tool ${name} is not allowed for the current API key.`);
    }

    const a = args;
    try {

      // Global chat-feature gate: chat_* tools refuse when admin disabled chat.
      if (name.startsWith('chat_') && !(await chatLlmService.isEnabled())) {
        return errorResult('Chat feature is disabled by an administrator');
      }

      let result: unknown;

      switch (name) {
        case 'project_create': {
          const proj = await projectsService.create({
            name: requireString(a, 'name'),
            path: optionalString(a, 'path'),
            description: optionalString(a, 'description'),
            techStack: optionalStringArray(a, 'techStack'),
            tags: optionalStringArray(a, 'tags'),
            repository: optionalString(a, 'repository'),
            instructions: optionalString(a, 'instructions'),
            components: optionalObjectArray(a, 'components'),
          });
          result = compactCreateResult(proj, { name: proj.name });
          break;
        }
        case 'project_list': {
          const projects = await projectsService.findAll(optionalBoolean(a, 'active'), optionalBoolean(a, 'favorite'));
          result = compactList(projects, ['instructions', 'components', '__v', 'description', 'repository', 'todoNumberFormat', 'milestoneNumberFormat', 'gitRepositories', 'createdAt', 'updatedAt']);
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
            tags: optionalStringArray(a, 'tags'),
            repository: optionalString(a, 'repository'),
            active: optionalBoolean(a, 'active'),
            instructions: optionalString(a, 'instructions'),
            components: optionalObjectArray(a, 'components'),
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
            soulsService.removeByProject(id),
            recurringTasksService.removeByProject(id),
            snippetsService.removeByProject(id),
            attachmentsService.removeByProject(id),
            releasesService.removeByProject(id),
            validationReportsService.removeByProject(id),
            docUpdateProposalsService.removeByProject(id),
            knowledgeGraphService.removeByProject(id),
            oracleService.removeByProject(id),
            workspacesService.removeByProject(id),
          ]);
          result = { deleted: true, id };
          break;
        }
        case 'project_tag_list':
          result = await projectsService.listTags();
          break;
        case 'project_tag_rename':
          result = await projectsService.renameTag(
            requireString(a, 'from'),
            requireString(a, 'to'),
          );
          break;
        case 'project_tag_merge':
          result = await projectsService.mergeTags(
            optionalStringArray(a, 'sources') ?? [],
            requireString(a, 'target'),
          );
          break;
        case 'project_tag_delete':
          result = await projectsService.deleteTag(requireString(a, 'name'));
          break;
        case 'customer_create': {
          const customer = await customersService.create({
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            status: optionalEnum(a, 'status', Object.values(CustomerStatus)),
            tags: optionalStringArray(a, 'tags'),
            primaryContactName: optionalString(a, 'primaryContactName'),
            primaryContactEmail: optionalString(a, 'primaryContactEmail'),
            primaryContactPhone: optionalString(a, 'primaryContactPhone'),
            website: optionalString(a, 'website'),
            notes: optionalString(a, 'notes'),
          });
          result = compactCreateResult(customer, { name: customer.name, status: customer.status });
          break;
        }
        case 'customer_list': {
          const customers = await customersService.findAll({
            status: optionalEnum(a, 'status', Object.values(CustomerStatus)),
            tag: optionalString(a, 'tag'),
            q: optionalString(a, 'q'),
            includeArchived: optionalBoolean(a, 'includeArchived'),
            projectId: optionalString(a, 'projectId'),
          });
          const compactCustomers = compactList(customers, ['notes', '__v']);
          result = applyPagination(compactCustomers, optionalNumber(a, 'limit'), optionalNumber(a, 'offset'));
          break;
        }
        case 'customer_get':
          result = await customersService.findById(requireString(a, 'id'));
          break;
        case 'customer_update':
          result = compactUpdateResult(await customersService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            status: optionalEnum(a, 'status', Object.values(CustomerStatus)),
            tags: optionalStringArray(a, 'tags'),
            primaryContactName: optionalString(a, 'primaryContactName'),
            primaryContactEmail: optionalString(a, 'primaryContactEmail'),
            primaryContactPhone: optionalString(a, 'primaryContactPhone'),
            website: optionalString(a, 'website'),
            notes: optionalString(a, 'notes'),
          }));
          break;
        case 'customer_archive':
          result = compactUpdateResult(await customersService.archive(requireString(a, 'id')));
          break;
        case 'customer_project_link': {
          const link = await customersService.createProjectLink(requireString(a, 'customerId'), {
            projectId: requireString(a, 'projectId'),
            status: optionalEnum(a, 'status', Object.values(CustomerProjectLinkStatus)),
            role: optionalString(a, 'role'),
            notes: optionalString(a, 'notes'),
            environmentIds: optionalStringArray(a, 'environmentIds'),
          });
          result = compactCreateResult(link, {
            customerId: link.customerId,
            projectId: link.projectId,
          });
          break;
        }
        case 'customer_project_list':
          result = compactList(
            await customersService.findProjectLinks(requireString(a, 'customerId')),
            ['__v'],
          );
          break;
        case 'customer_project_update':
          result = compactUpdateResult(await customersService.updateProjectLink(
            requireString(a, 'customerId'),
            requireString(a, 'linkId'),
            {
              status: optionalEnum(a, 'status', Object.values(CustomerProjectLinkStatus)),
              role: optionalString(a, 'role'),
              notes: optionalString(a, 'notes'),
              environmentIds: optionalStringArray(a, 'environmentIds'),
            },
          ));
          break;
        case 'customer_project_unlink':
          await customersService.deleteProjectLink(requireString(a, 'customerId'), requireString(a, 'linkId'));
          result = { deleted: true, id: a.linkId };
          break;
        case 'project_customer_links':
          result = compactList(
            await customersService.findLinksByProject(requireString(a, 'projectId')),
            ['__v'],
          );
          break;
        case 'contact_create': {
          const contact = await contactsService.create(requireString(a, 'customerId'), {
            name: requireString(a, 'name'),
            role: optionalString(a, 'role'),
            email: optionalString(a, 'email'),
            phone: optionalString(a, 'phone'),
            notes: optionalString(a, 'notes'),
            isPrimary: optionalBoolean(a, 'isPrimary'),
            sortOrder: optionalNumber(a, 'sortOrder'),
          });
          result = compactCreateResult(contact, { name: contact.name });
          break;
        }
        case 'contact_list':
          result = compactList(
            await contactsService.findByCustomer(requireString(a, 'customerId')),
            ['__v'],
          );
          break;
        case 'contact_get':
          result = await contactsService.findById(requireString(a, 'id'));
          break;
        case 'contact_update':
          result = compactUpdateResult(await contactsService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            role: optionalString(a, 'role'),
            email: optionalString(a, 'email'),
            phone: optionalString(a, 'phone'),
            notes: optionalString(a, 'notes'),
            isPrimary: optionalBoolean(a, 'isPrimary'),
            sortOrder: optionalNumber(a, 'sortOrder'),
          }));
          break;
        case 'contact_delete':
          await contactsService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'todo_create': {
          const todo = await todosService.create({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            title: requireString(a, 'title'),
            description: optionalString(a, 'description'),
            status: optionalEnum(a, 'status', Object.values(TodoStatus)),
            priority: optionalEnum(a, 'priority', Object.values(TodoPriority)),
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            blockedBy: optionalStringArray(a, 'blockedBy'),
            repoLabel: optionalString(a, 'repoLabel'),
            userStories: optionalString(a, 'userStories'),
            acceptanceCriteria: Array.isArray(a.acceptanceCriteria) ? a.acceptanceCriteria : undefined,
            outOfScope: optionalString(a, 'outOfScope'),
            edgeCases: optionalString(a, 'edgeCases'),
            openQuestions: optionalStringArray(a, 'openQuestions'),
          });
          result = compactCreateResult(todo, { displayNumber: todo.displayNumber, title: todo.title });
          break;
        }
        case 'todo_list': {
          const todos = await todosService.findAll({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            status: optionalEnum(a, 'status', Object.values(TodoStatus)),
            priority: optionalString(a, 'priority'),
            milestoneId: optionalString(a, 'milestoneId'),
            tag: optionalString(a, 'tag'),
            includeArchived: optionalBoolean(a, 'includeArchived'),
          });
          const compactTodos = compactList(todos, ['description', 'comments', 'blockedBy', '__v']);
          const scoped = optionalString(a, 'projectId') || optionalString(a, 'customerId');
          const todoLimit = optionalNumber(a, 'limit') ?? (scoped ? undefined : 50);
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
            status: optionalEnum(a, 'status', Object.values(TodoStatus)),
            priority: optionalEnum(a, 'priority', Object.values(TodoPriority)),
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            blockedBy: optionalStringArray(a, 'blockedBy'),
            archived: optionalBoolean(a, 'archived'),
            repoLabel: optionalString(a, 'repoLabel'),
            userStories: optionalString(a, 'userStories'),
            acceptanceCriteria: Array.isArray(a.acceptanceCriteria) ? a.acceptanceCriteria : undefined,
            outOfScope: optionalString(a, 'outOfScope'),
            edgeCases: optionalString(a, 'edgeCases'),
            openQuestions: optionalStringArray(a, 'openQuestions'),
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
        case 'todo_ask_question': {
          const todoAskId = requireString(a, 'todoId');
          const userId = RequestContext.getUser()?.userId;
          const questionEntry = await questionsService.create({
            question: requireString(a, 'question'),
            options: optionalStringArray(a, 'options'),
            context: optionalString(a, 'context'),
            todoId: todoAskId,
            timeoutSeconds: optionalNumber(a, 'timeoutSeconds') ?? 300,
            agentName: optionalString(a, 'agentName'),
            agentRunId: optionalString(a, 'agentRunId'),
            direction: 'agent_to_user',
          }, userId);
          const timeoutMs = questionEntry.timeoutMs;
          const waitResult = await questionsService.waitForAnswer(questionEntry._id.toString(), timeoutMs);
          result = { ...waitResult, questionId: questionEntry._id.toString() };
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
            result = sessions.map((s) => {
              const obj = toPlainDoc(s);
              return {
                _id: obj._id,
                projectId: obj.projectId,
                summary: snippet(asString(obj.summary)),
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
          const kScope = optionalEnum(a, 'scope', KNOWLEDGE_SCOPES);
          const kDto: CreateKnowledgeDto = {
            topic: requireString(a, 'topic'),
            content: requireString(a, 'content'),
            tags: optionalStringArray(a, 'tags'),
            category: optionalString(a, 'category'),
            scope: kScope,
          };
          const kPid = optionalString(a, 'projectId');
          if (kPid) kDto.projectId = kPid;
          const kCid = optionalString(a, 'customerId');
          if (kCid) kDto.customerId = kCid;
          const kEntry = await knowledgeService.create(kDto);
          result = compactCreateResult(kEntry, { topic: kEntry.topic, scope: kEntry.scope });
          break;
        }
        case 'knowledge_search': {
          const kProjectId = optionalString(a, 'projectId');
          const kCustomerId = optionalString(a, 'customerId');
          const kSearchScope = optionalString(a, 'scope');
          const searchResults = await knowledgeService.search(
            requireString(a, 'query'),
            kProjectId,
            kSearchScope,
            kCustomerId,
          );
          const limited = searchResults.slice(0, optionalNumber(a, 'limit') || 10);
          result = limited.map((item) => {
            const obj = toPlainDoc(item);
            if (kProjectId || kCustomerId) {
              // Scoped: return snippet
              obj.content = snippet(asString(obj.content));
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
            optionalString(a, 'projectId'),
            {
              customerId: optionalString(a, 'customerId'),
              category: optionalString(a, 'category'),
              scope: optionalString(a, 'scope'),
              limit: optionalNumber(a, 'limit'),
              offset: optionalNumber(a, 'offset'),
            },
          );
          const compactEntries = compactList(entries, ['content', '__v']);
          result = compactEntries;
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
        case 'stack_create': {
          const s = await stackService.create({
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
          });
          result = compactCreateResult(s, { name: s.name });
          break;
        }
        case 'stack_list': {
          const stacks = await stackService.findAll();
          result = compactList(stacks, []);
          break;
        }
        case 'stack_get':
          result = await stackService.findById(requireString(a, 'id'));
          break;
        case 'stack_update': {
          const s = await stackService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
          });
          result = compactUpdateResult(s);
          break;
        }
        case 'stack_delete':
          await stackService.remove(requireString(a, 'id'));
          result = { deleted: true };
          break;
        case 'stack_entry_add': {
          const s = await stackService.addEntry(requireString(a, 'id'), {
            title: requireString(a, 'title'),
            content: optionalString(a, 'content'),
          });
          result = s;
          break;
        }
        case 'stack_entry_update': {
          const s = await stackService.updateEntry(
            requireString(a, 'id'),
            requireString(a, 'entryId'),
            {
              title: optionalString(a, 'title'),
              content: optionalString(a, 'content'),
              order: optionalNumber(a, 'order'),
            },
          );
          result = s;
          break;
        }
        case 'stack_entry_remove': {
          const s = await stackService.removeEntry(
            requireString(a, 'id'),
            requireString(a, 'entryId'),
          );
          result = s;
          break;
        }
        case 'stack_export_markdown': {
          const { content } = await stackService.exportAsMarkdown(
            requireString(a, 'id'),
            optionalString(a, 'entryId'),
          );
          return { content: [{ type: 'text' as const, text: content }] };
        }
        case 'changelog_add': {
          // `changes` ist im Tool-Schema required, im Mongo-Schema steht aber
          // `default: []`. Ohne diese Prüfung legte ein Aufruf ohne `changes`
          // stillschweigend einen leeren Changelog an.
          const clChanges = optionalStringArray(a, 'changes');
          if (!clChanges) throw new Error('Missing required field: changes');
          const clEntry = await changelogService.create({
            projectId: requireString(a, 'projectId'),
            version: optionalString(a, 'version'),
            changes: clChanges,
            summary: optionalString(a, 'summary'),
            component: optionalString(a, 'component'),
            repoLabel: optionalString(a, 'repoLabel'),
          });
          result = compactCreateResult(clEntry, { version: clEntry.version });
          break;
        }
        case 'changelog_list': {
          const clLimit = optionalNumber(a, 'limit') || 10;
          const changelogs = await changelogService.findByProject(
            requireString(a, 'projectId'),
            clLimit + (optionalNumber(a, 'offset') || 0),
          );
          const compactChangelogs = compactList(changelogs, ['changes', '__v']);
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
            repoLabel: optionalString(a, 'repoLabel'),
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
            status: optionalEnum(a, 'status', Object.values(MilestoneStatus)),
            dueDate: optionalString(a, 'dueDate'),
          });
          result = compactCreateResult(ms, { displayNumber: ms.displayNumber, name: ms.name });
          break;
        }
        case 'milestone_list': {
          const milestones = await milestonesService.findByProject(
            requireString(a, 'projectId'),
            optionalEnum(a, 'status', Object.values(MilestoneStatus)),
            optionalBoolean(a, 'includeArchived'),
          );
          result = compactList(milestones, ['description', '__v']);
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
            status: optionalEnum(a, 'status', Object.values(MilestoneStatus)),
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
        case 'milestone_export': {
          const msExportId = await milestonesService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          const { content: markdownContent } = await milestonesService.exportAsMarkdown(msExportId);
          return { content: [{ type: 'text' as const, text: markdownContent }] };
        }
        case 'milestone_import_preview': {
          const parsed = milestonesService.parseMarkdown(requireString(a, 'markdown'));
          return { content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }] };
        }
        case 'milestone_import_apply': {
          const importResult = await milestonesService.importFromParsed(
            requireString(a, 'projectId'),
            requireObject<ParsedMilestone>(a, 'parsed'),
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(importResult, null, 2) }] };
        }
        case 'milestone_create_with_todos': {
          const cwt_projectId = requireString(a, 'projectId');
          const cwt_name = requireString(a, 'name');
          const cwt_description = optionalString(a, 'description');
          const cwt_todos = optionalObjectArray<ParsedTodo>(a, 'todos') ?? [];
          const cwt_result = await milestonesService.importFromParsed(cwt_projectId, {
            name: cwt_name,
            description: cwt_description,
            todos: cwt_todos,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(cwt_result, null, 2) }] };
        }
        case 'milestone_ai_complete': {
          const msAiId = await milestonesService.resolveId({
            id: optionalString(a, 'id'),
            projectId: optionalString(a, 'projectId'),
            number: optionalString(a, 'number'),
          });
          const aiResult = await milestonesService.aiComplete(msAiId, requireString(a, 'summaryMarkdown'));
          return { content: [{ type: 'text' as const, text: JSON.stringify(aiResult, null, 2) }] };
        }
        case 'notify_user': {
          const nTitle = requireString(a, 'title');
          const nBody = requireString(a, 'body');
          const nUrl = optionalString(a, 'url');
          const notification = await notificationsService.create(nTitle, nBody, nUrl, 'notify_user');
          result = { notificationId: notification._id.toString() };
          break;
        }
        case 'user_list_active': {
          const users = await authService.findActiveUsers(optionalNumber(a, 'windowMinutes') ?? 15);
          result = { users };
          break;
        }
        case 'ask_user': {
          const userId = RequestContext.getUser()?.userId;
          const targetUsername = optionalString(a, 'targetUsername');
          let targetUserId = optionalString(a, 'targetUserId');
          if (targetUsername) {
            const targetUser = await authService.findByUsername(targetUsername);
            if (!targetUser || !targetUser.active) {
              throw new Error(`Unknown or inactive targetUsername: ${targetUsername}`);
            }
            targetUserId = targetUser._id.toString();
          }
          const targetRole = optionalString(a, 'targetRole');
          if (targetRole && targetRole !== 'admin' && targetRole !== 'user') {
            throw new Error(`Invalid targetRole: ${targetRole}`);
          }
          const broadcast = optionalBoolean(a, 'broadcast') ?? undefined;
          // `kind` wird beim Mappen geprüft statt danach behauptet: die
          // Schleife unten validierte den Wert erst, nachdem der Cast ihn
          // bereits als gültig ausgegeben hatte.
          const escalationChain = optionalObjectArray<PlainDoc>(a, 'escalationChain')?.map(
            (step, idx) => {
              const kind = ESCALATION_KINDS.find((candidate) => candidate === step.kind);
              if (kind === undefined) {
                throw new Error(`escalationChain[${idx}].kind invalid`);
              }
              return {
                kind,
                userId: asString(step.userId),
                role: asString(step.role),
                afterMs: Number(step.afterMs),
              };
            },
          );
          if (escalationChain) {
            for (const [idx, step] of escalationChain.entries()) {
              if (step.kind === 'user' && !step.userId) {
                throw new Error(`escalationChain[${idx}].userId required when kind=user`);
              }
              if (step.kind === 'role' && !step.role) {
                throw new Error(`escalationChain[${idx}].role required when kind=role`);
              }
              if (!Number.isFinite(step.afterMs) || step.afterMs < 10000 || step.afterMs > 3600000) {
                throw new Error(`escalationChain[${idx}].afterMs must be between 10000 and 3600000`);
              }
            }
          }
          const checkSimilar = optionalBoolean(a, 'checkSimilar') ?? false;
          let priorMatches: Array<Record<string, unknown>> | undefined;
          if (checkSimilar) {
            try {
              priorMatches = await ragService.search(
                requireString(a, 'question'),
                optionalString(a, 'projectId'),
                'question',
                3,
                optionalString(a, 'customerId'),
              );
            } catch {
              // RAG offline shouldn't break ask_user — just skip the hint.
              priorMatches = undefined;
            }
          }

          const questionEntry = await questionsService.create({
            question: requireString(a, 'question'),
            options: optionalStringArray(a, 'options'),
            context: optionalString(a, 'context'),
            todoId: optionalString(a, 'todoId'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            researchSessionId: optionalString(a, 'researchSessionId'),
            chatSessionId: optionalString(a, 'chatSessionId'),
            milestoneId: optionalString(a, 'milestoneId'),
            targetUserId,
            targetRole,
            broadcast,
            timeoutSeconds: optionalNumber(a, 'timeoutSeconds'),
            escalationChain,
          }, userId);
          const timeoutMs = questionEntry.timeoutMs;
          const waitResult = await questionsService.waitForAnswer(questionEntry._id.toString(), timeoutMs);
          // Surface the questionId so an agent that later wants to check or
          // answer a still-open question can find it back. M-30: a timed-out
          // question stays answerable by the user via the todo detail view.
          result = {
            ...waitResult,
            questionId: questionEntry._id.toString(),
            ...(priorMatches && priorMatches.length > 0 ? { priorMatches } : {}),
          };
          break;
        }
        case 'question_list': {
          const direction = optionalEnum(a, 'direction', ['agent_to_user', 'user_to_agent'] as const);
          const todoId = optionalString(a, 'todoId');
          const includeAnswered = optionalBoolean(a, 'includeAnswered') ?? false;
          if (todoId) {
            const list = await questionsService.findByTodo(todoId, includeAnswered);
            const filtered = direction ? list.filter((q) => q.direction === direction) : list;
            result = { items: filtered.map(serializeQuestion), total: filtered.length };
          } else {
            const limit = optionalNumber(a, 'limit') ?? 50;
            const open = await questionsService.findOpen({
              projectId: optionalString(a, 'projectId'),
              direction,
              limit,
              includeAnswered,
            });
            result = { items: open.items.map(serializeQuestion), total: open.total };
          }
          break;
        }
        case 'question_get': {
          const q = await questionsService.findById(requireString(a, 'id'));
          result = serializeQuestion(q);
          break;
        }
        case 'question_answer': {
          const updated = await questionsService.answer(
            requireString(a, 'id'),
            requireString(a, 'answer'),
            { byAgent: true },
          );
          result = serializeQuestion(updated);
          break;
        }
        case 'question_convert_to_knowledge': {
          const knowledge = await questionsService.convertToKnowledge(
            requireString(a, 'questionId'),
            {
              topic: requireString(a, 'topic'),
              content: optionalString(a, 'content'),
              tags: optionalStringArray(a, 'tags'),
              category: optionalString(a, 'category'),
              scope: optionalEnum(a, 'scope', QUESTION_KNOWLEDGE_SCOPES),
            },
          );
          result = knowledge.toJSON ? knowledge.toJSON() : { ...knowledge };
          break;
        }
        case 'question_search': {
          const limit = Math.max(1, Math.min(optionalNumber(a, 'limit') ?? 5, 20));
          const hits = await ragService.search(
            requireString(a, 'query'),
            optionalString(a, 'projectId'),
            'question',
            limit,
            optionalString(a, 'customerId'),
          );
          result = { items: hits, total: hits.length };
          break;
        }
        case 'question_cancel': {
          const userId = RequestContext.getUser()?.userId;
          const updated = await questionsService.cancel(
            requireString(a, 'id'),
            optionalString(a, 'reason'),
            userId,
          );
          result = serializeQuestion(updated);
          break;
        }
        case 'question_snooze': {
          const userId = RequestContext.getUser()?.userId;
          const until = new Date(requireString(a, 'snoozeUntil'));
          const updated = await questionsService.snooze(requireString(a, 'id'), until, userId);
          result = serializeQuestion(updated);
          break;
        }
        case 'question_create_followup_todo': {
          const out = await questionsService.createFollowupTodo(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            description: optionalString(a, 'description'),
            priority: optionalEnum(a, 'priority', TODO_PRIORITY_LITERALS),
          });
          result = { todoId: out.todoId, question: serializeQuestion(out.question) };
          break;
        }
        case 'question_mark_as_decision': {
          const out = await questionsService.markAsDecision(requireString(a, 'id'), {
            decision: requireString(a, 'decision'),
            rationale: optionalString(a, 'rationale'),
            scope: optionalString(a, 'scope'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = { knowledgeId: out.knowledgeId, question: serializeQuestion(out.question) };
          break;
        }
        case 'environment_create': {
          const env = await environmentsService.create({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            host: optionalString(a, 'host'),
            port: optionalNumber(a, 'port'),
            user: optionalString(a, 'user'),
            url: optionalString(a, 'url'),
            variables: optionalObjectArray(a, 'variables'),
            active: optionalBoolean(a, 'active'),
          });
          result = compactCreateResult(env, { name: env.name });
          break;
        }
        case 'environment_list': {
          const envProjectId = optionalString(a, 'projectId');
          const envCustomerId = optionalString(a, 'customerId');
          if (!envProjectId && !envCustomerId) {
            throw new Error('environment_list requires projectId or customerId');
          }
          const envs = envCustomerId
            ? await environmentsService.findByCustomer(envCustomerId)
            : await environmentsService.findByProject(envProjectId!);
          result = envs.map((e) => {
            const obj = toPlainDoc(e);
            return {
              _id: obj._id,
              projectId: obj.projectId,
              customerId: obj.customerId,
              name: obj.name,
              active: obj.active,
              variableCount: countArray(obj.variables),
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
            description: optionalString(a, 'description'),
            host: optionalString(a, 'host'),
            port: optionalNumber(a, 'port'),
            user: optionalString(a, 'user'),
            url: optionalString(a, 'url'),
            variables: optionalObjectArray(a, 'variables'),
            active: optionalBoolean(a, 'active'),
          }));
          break;
        case 'environment_delete':
          await environmentsService.delete(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'secret_set': {
          const secret = await secretsService.create({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            environmentId: optionalString(a, 'environmentId'),
            key: requireString(a, 'key'),
            value: requireString(a, 'value'),
            description: optionalString(a, 'description'),
            type: optionalString(a, 'type'),
          });
          result = compactCreateResult(secret, { key: secret.key });
          break;
        }
        case 'secret_get':
          result = await secretsService.findById(requireString(a, 'id'));
          break;
        case 'secret_list': {
          const secProjectId = optionalString(a, 'projectId');
          const secCustomerId = optionalString(a, 'customerId');
          if (!secProjectId && !secCustomerId) {
            throw new Error('secret_list requires projectId or customerId');
          }
          result = secCustomerId
            ? await secretsService.findByCustomer(secCustomerId, optionalString(a, 'environmentId'))
            : await secretsService.findByProject(secProjectId!, optionalString(a, 'environmentId'));
          break;
        }
        case 'secret_delete':
          await secretsService.delete(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'environment_export': {
          const expProjectId = optionalString(a, 'projectId');
          const expCustomerId = optionalString(a, 'customerId');
          if (!expProjectId && !expCustomerId) {
            throw new Error('environment_export requires projectId or customerId');
          }
          const owner = expCustomerId ? { customerId: expCustomerId } : { projectId: expProjectId! };
          const envId = requireString(a, 'environmentId');
          const includeGlobal = optionalBoolean(a, 'includeGlobalSecrets') !== false;
          const env = await environmentsService.findById(envId);
          const ownerMatches = owner.customerId
            ? env.customerId?.toString() === owner.customerId
            : env.projectId?.toString() === owner.projectId;
          if (!ownerMatches) {
            throw new Error('Environment does not belong to the specified owner');
          }
          const envSecrets = await secretsService.getDecryptedForEnvironment(owner, envId);
          const globalSecrets = includeGlobal
            ? await secretsService.getDecryptedForEnvironment(owner, '')
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
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            title: requireString(a, 'title'),
            content: optionalString(a, 'content'),
            category: optionalString(a, 'category'),
            sortOrder: optionalNumber(a, 'sortOrder'),
          });
          result = compactCreateResult(manual, { title: manual.title });
          break;
        }
        case 'manual_list': {
          const manualProjectId = optionalString(a, 'projectId');
          const manualCustomerId = optionalString(a, 'customerId');
          if (!manualProjectId && !manualCustomerId) {
            throw new Error('manual_list requires projectId or customerId');
          }
          const manuals = manualCustomerId
            ? await manualsService.findByCustomer(manualCustomerId, optionalString(a, 'category'))
            : await manualsService.findByProject(manualProjectId!, optionalString(a, 'category'));
          result = compactList(manuals, ['content', '__v']);
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
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            title: requireString(a, 'title'),
            content: requireString(a, 'content'),
            sources: optionalStringArray(a, 'sources'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(rEntry, { title: rEntry.title });
          break;
        }
        case 'research_search': {
          const rProjectId = optionalString(a, 'projectId');
          const rCustomerId = optionalString(a, 'customerId');
          const rSearchResults = await researchService.search(
            requireString(a, 'query'),
            rProjectId,
            rCustomerId,
          );
          const rLimited = rSearchResults.slice(0, optionalNumber(a, 'limit') || 10);
          result = rLimited.map((item) => {
            const obj = toPlainDoc(item);
            if (rProjectId || rCustomerId) {
              obj.content = snippet(asString(obj.content));
            } else {
              delete obj.content;
            }
            obj.sourceCount = countArray(obj.sources);
            delete obj.sources;
            delete obj.__v;
            return obj;
          });
          break;
        }
        case 'research_list': {
          const rProjectId = optionalString(a, 'projectId');
          const rCustomerId = optionalString(a, 'customerId');
          if (!rProjectId && !rCustomerId) {
            throw new Error('research_list requires projectId or customerId');
          }
          const rEntries = rProjectId
            ? await researchService.findByProject(rProjectId)
            : await researchService.findByCustomer(rCustomerId!);
          const compactResearch = rEntries.map((item) => {
            const obj = toPlainDoc(item);
            delete obj.content;
            obj.sourceCount = countArray(obj.sources);
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
        case 'research_topic_create': {
          const topic = await researchTopicService.create(
            {
              title: requireString(a, 'title'),
              brief: requireString(a, 'brief'),
              scope: optionalObject(a, 'scope'),
              webSearch: optionalObject(a, 'webSearch'),
              schedule: requireObject(a, 'schedule'),
              guardrails: optionalObject(a, 'guardrails'),
              notifyOnComplete: optionalBoolean(a, 'notifyOnComplete'),
            },
            requireUserId(),
          );
          result = compactCreateResult(topic, {
            displayNumber: topic.displayNumber,
            title: topic.title,
          });
          break;
        }
        case 'research_topic_list': {
          const topics = await researchTopicService.list({
            active: optionalBoolean(a, 'active'),
            q: optionalString(a, 'q'),
          });
          const compactTopics = topics.map((t) => {
            const obj = typeof t.toJSON === 'function' ? t.toJSON() : t;
            return {
              _id: idToString(obj._id),
              displayNumber: obj.displayNumber,
              title: obj.title,
              briefSnippet: snippet(obj.brief),
              ownerUserId: idToString(obj.ownerUserId),
              scheduleActive: obj.schedule?.active,
              frequency: obj.schedule?.frequency,
              nextRun: obj.schedule?.nextRun,
              lastRun: obj.schedule?.lastRun,
              lastRunStatus: obj.schedule?.lastRunStatus,
              webSearchEnabled: obj.webSearch?.enabled,
              notifyOnComplete: obj.notifyOnComplete,
            };
          });
          result = applyPagination(compactTopics, optionalNumber(a, 'limit'), optionalNumber(a, 'offset'));
          break;
        }
        case 'research_topic_get':
          result = await researchTopicService.get(requireString(a, 'id'));
          break;
        case 'research_topic_update': {
          const updatedTopic = await researchTopicService.update(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            brief: optionalString(a, 'brief'),
            scope: optionalObject(a, 'scope'),
            webSearch: optionalObject(a, 'webSearch'),
            schedule: optionalObject(a, 'schedule'),
            guardrails: optionalObject(a, 'guardrails'),
            notifyOnComplete: optionalBoolean(a, 'notifyOnComplete'),
          });
          result = compactUpdateResult(updatedTopic);
          break;
        }
        case 'research_topic_delete':
          await researchTopicService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'research_topic_run': {
          const runTopicId = requireString(a, 'id');

          // Same active-run guard as `ResearchAgentController.startRun`'s
          // REST `409` (final-review fix F2) — without it, an MCP-triggered
          // run could overlap a scheduled/REST/other-MCP run for the same
          // topic, since `ResearchAgentService.run` itself starts
          // unconditionally.
          const existingRuns = await researchRunService.listByTopic(runTopicId);
          const activeRun = existingRuns.find(
            (r) => r.status === ResearchRunStatus.RUNNING || r.status === ResearchRunStatus.QUEUED,
          );
          if (activeRun) {
            throw new Error(
              `Topic ${runTopicId} already has an active run (#${activeRun.number}, status=${activeRun.status})`,
            );
          }

          let runAlreadyCreated = false;
          result = await new Promise<{ runId: string }>((resolve, reject) => {
            researchAgentService
              .run(runTopicId, 'manual', undefined, (runId) => {
                runAlreadyCreated = true;
                resolve({ runId });
              })
              .catch((err) => {
                // Only reject the tool call itself if the run was never even
                // created (e.g. topic/owner not found) — ResearchAgentService.run
                // never rejects for a run-local failure once onRunCreated has
                // fired (those are recorded on the run via finalize()), so this
                // branch is purely to avoid an unhandled rejection for that
                // already-settled background promise.
                if (!runAlreadyCreated) {
                  reject(err instanceof Error ? err : new Error(String(err)));
                }
              });
          });
          break;
        }
        case 'research_run_list': {
          const runs = await researchRunService.listByTopic(requireString(a, 'topicId'));
          const compactRuns = compactList(runs, ['steps']);
          result = applyPagination(compactRuns, optionalNumber(a, 'limit'), optionalNumber(a, 'offset'));
          break;
        }
        case 'research_run_get':
          result = await researchRunService.getRun(requireString(a, 'id'));
          break;
        case 'research_artifact_list': {
          const artifacts = await researchArtifactService.listByTopic(requireString(a, 'topicId'));
          const compactArtifacts = artifacts.map((art) => ({ ...art, summary: snippet(asString(art.summary)) }));
          result = applyPagination(compactArtifacts, optionalNumber(a, 'limit'), optionalNumber(a, 'offset'));
          break;
        }
        case 'research_artifact_get': {
          const artTopicId = requireString(a, 'topicId');
          const artSlug = requireString(a, 'slug');
          const artifact = await researchArtifactService.getBySlug(artTopicId, artSlug);
          if (!artifact) throw new Error(`Artifact "${artSlug}" not found for topic ${artTopicId}`);
          result = artifact;
          break;
        }
        case 'research_artifact_update': {
          const artifactTopicId = requireString(a, 'topicId');
          const artifactTopic = await researchTopicService.get(artifactTopicId);
          const artifact = await researchArtifactService.write(
            artifactTopicId,
            {
              slug: requireString(a, 'slug'),
              title: requireString(a, 'title'),
              content: requireString(a, 'content'),
              summary: optionalString(a, 'summary'),
              tags: optionalStringArray(a, 'tags'),
              sources: optionalStringArray(a, 'sources'),
              changeNote: optionalString(a, 'changeNote'),
            },
            artifactTopic.scope,
          );
          result = {
            ...compactUpdateResult(artifact),
            slug: artifact.slug,
            version: artifact.version,
          };
          break;
        }
        case 'research_artifact_delete':
          await researchArtifactService.remove(requireString(a, 'topicId'), requireString(a, 'slug'));
          result = { deleted: true, topicId: a.topicId, slug: a.slug };
          break;
        case 'system_instructions_get': {
          const instructions = await settingsService.getOrDefault(
            AGENT_INSTRUCTIONS_KEY,
            DEFAULT_AGENT_INSTRUCTIONS,
          );
          const projectId = optionalString(a, 'projectId');
          const res: Record<string, unknown> = { globalInstructions: instructions };
          if (projectId) {
            const project = await projectsService.findById(projectId);
            if (project?.instructions) {
              res.projectInstructions = project.instructions;
            }
            const soul = await soulsService.findByProject(projectId);
            if (soul) {
              const soulObj = toPlainDoc(soul.toObject());
              const sections = [
                { key: 'vision', label: 'Vision' },
                { key: 'principles', label: 'Principles' },
                { key: 'conventions', label: 'Conventions' },
                { key: 'communication', label: 'Communication' },
                { key: 'boundaries', label: 'Boundaries' },
                { key: 'workflow', label: 'Workflow' },
                { key: 'quality', label: 'Quality' },
              ];
              const soulParts = sections
                .filter((s) => soulObj[s.key])
                .map((s) => `### ${s.label}\n${asString(soulObj[s.key]) ?? ''}`);
              if (soulParts.length > 0) {
                res.projectSoul = `## Project Soul\n\n${soulParts.join('\n\n')}`;
              }
            }
          }
          result = res;
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
            dbType: requireEnum(a, 'dbType', Object.values(DbType)),
            database: optionalString(a, 'database'),
            description: optionalString(a, 'description'),
            fields: optionalObjectArray(a, 'fields') ?? [],
            indexes: optionalObjectArray(a, 'indexes') ?? [],
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(schema, { name: schema.name });
          break;
        }
        case 'schema_list': {
          const schemas = await schemasService.findByProject(
            requireString(a, 'projectId'),
            optionalString(a, 'dbType'),
            optionalStringArray(a, 'tags'),
          );
          const compactSchemas = compactList(schemas, ['fields', 'indexes', '__v']);
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
          result = compactUpdateResult(await schemasService.update(requireString(a, 'id'), updateData));
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
            result = versions.map((v) => {
              const obj = toPlainDoc(v);
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
            status: optionalEnum(a, 'status', Object.values(FeatureStatus)),
            version: optionalString(a, 'version'),
            priority: optionalEnum(a, 'priority', Object.values(FeaturePriority)),
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(feat, { name: feat.name });
          break;
        }
        case 'feature_list': {
          const features = await featuresService.findByProject(requireString(a, 'projectId'), {
            status: optionalEnum(a, 'status', Object.values(FeatureStatus)),
            category: optionalString(a, 'category'),
          });
          result = applyPagination(
            compactList(features, ['description', '__v']),
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
            status: optionalEnum(a, 'status', Object.values(FeatureStatus)),
            version: optionalString(a, 'version'),
            priority: optionalEnum(a, 'priority', Object.values(FeaturePriority)),
            tags: optionalStringArray(a, 'tags'),
          }));
          break;
        case 'feature_delete':
          await featuresService.remove(requireString(a, 'id'));
          result = { deleted: true, id: requireString(a, 'id') };
          break;
        case 'release_create': {
          const rel = await releasesService.create({
            projectId: requireString(a, 'projectId'),
            version: requireString(a, 'version'),
            title: optionalString(a, 'title'),
            description: optionalString(a, 'description'),
            releaseType: optionalEnum(a, 'releaseType', Object.values(ReleaseType)),
            platform: optionalEnum(a, 'platform', Object.values(ReleasePlatform)),
            status: optionalEnum(a, 'status', Object.values(ReleaseStatus)),
            downloadUrl: optionalString(a, 'downloadUrl'),
            tags: optionalStringArray(a, 'tags'),
            assets: optionalObjectArray(a, 'assets'),
          });
          result = compactCreateResult(rel, { version: rel.version });
          break;
        }
        case 'release_list': {
          const releases = await releasesService.findByProject(
            requireString(a, 'projectId'),
            {
              status: optionalEnum(a, 'status', Object.values(ReleaseStatus)),
              platform: optionalEnum(a, 'platform', Object.values(ReleasePlatform)),
              releaseType: optionalEnum(a, 'releaseType', Object.values(ReleaseType)),
            },
            optionalNumber(a, 'limit'),
            optionalNumber(a, 'offset'),
          );
          result = compactList(releases, ['description', 'assets', 'downloadUrl', 'gitlabReleaseId', 'gitlabTagName', 'providerReleaseId', 'repoLabel', '__v']);
          break;
        }
        case 'release_get':
          result = await releasesService.findById(requireString(a, 'id'));
          break;
        case 'release_update':
          result = compactUpdateResult(await releasesService.update(requireString(a, 'id'), {
            version: optionalString(a, 'version'),
            title: optionalString(a, 'title'),
            description: optionalString(a, 'description'),
            releaseType: optionalEnum(a, 'releaseType', Object.values(ReleaseType)),
            platform: optionalEnum(a, 'platform', Object.values(ReleasePlatform)),
            status: optionalEnum(a, 'status', Object.values(ReleaseStatus)),
            downloadUrl: optionalString(a, 'downloadUrl'),
            tags: optionalStringArray(a, 'tags'),
            assets: optionalObjectArray(a, 'assets'),
          }));
          break;
        case 'release_delete':
          await releasesService.remove(requireString(a, 'id'));
          result = { deleted: true, id: requireString(a, 'id') };
          break;
        // ALIAS: release_sync_gitlab → syncReleases() across all providers. Renamed in next release.
        case 'release_sync_gitlab':
          result = await releasesService.syncReleases(
            requireString(a, 'projectId'),
            optionalNumber(a, 'repoIndex'),
          );
          break;
        case 'dependency_add': {
          const dep = await dependenciesService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            version: requireString(a, 'version'),
            packageManager: requireEnum(a, 'packageManager', Object.values(PackageManager)),
            description: optionalString(a, 'description'),
            devDependency: a.devDependency === true,
            category: optionalString(a, 'category'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = compactCreateResult(dep, { name: dep.name, version: dep.version });
          break;
        }
        case 'dependency_list': {
          const deps = await dependenciesService.findByProject(requireString(a, 'projectId'), {
            packageManager: optionalEnum(a, 'packageManager', Object.values(PackageManager)),
            category: optionalString(a, 'category'),
            devDependency: a.devDependency !== undefined ? a.devDependency === true : undefined,
          });
          result = applyPagination(
            compactList(deps, ['description', 'tags', '__v']),
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
            packageManager: requireEnum(a, 'packageManager', Object.values(PackageManager)),
            dependencies: optionalObjectArray(a, 'dependencies') ?? [],
          });
          result = scanResult;
          break;
        }
        case 'harness_get': {
          if (optionalBoolean(a, 'raw') === true) {
            const scope = requireEnum(a, 'scope', HARNESS_SCOPES);
            const level = await harnessService.findByOwner({
              scope,
              projectId: optionalString(a, 'projectId'),
              customerId: optionalString(a, 'customerId'),
            });
            result = level ?? {
              message: `No harness defined yet for scope '${scope}'. Use harness_section_set to create one.`,
            };
            break;
          }
          result = await harnessService.resolve(requireString(a, 'projectId'));
          break;
        }
        case 'harness_list': {
          result = await harnessService.list(optionalEnum(a, 'scope', HARNESS_SCOPES));
          break;
        }
        case 'harness_section_set': {
          /*
           * Die Enum-Prüfungen stehen hier und nicht nur im DTO: dieser Pfad
           * geht am Controller und damit an class-validator vorbei. Ohne sie
           * landete ein erfundenes `kind` still im Dokument — und der Resolver
           * reicht unbekannte Kinds bewusst durch, es fiele also nirgends auf.
           */
          const owner = {
            scope: requireEnum(a, 'scope', HARNESS_SCOPES),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          };
          const harness = await harnessService.sectionSet(owner, {
            key: requireString(a, 'key'),
            kind: optionalEnum(a, 'kind', HARNESS_SECTION_KINDS) ?? 'prose',
            title: optionalString(a, 'title'),
            body: optionalString(a, 'body'),
            mergeStrategy: optionalEnum(a, 'mergeStrategy', HARNESS_MERGE_STRATEGIES),
            order: optionalNumber(a, 'order'),
            enabled: optionalBoolean(a, 'enabled'),
          });
          result = { id: harness._id.toString(), scope: harness.scope, sections: harness.sections.length };
          break;
        }
        case 'harness_section_delete': {
          const harness = await harnessService.sectionDelete(
            {
              scope: requireEnum(a, 'scope', HARNESS_SCOPES),
              projectId: optionalString(a, 'projectId'),
              customerId: optionalString(a, 'customerId'),
            },
            requireString(a, 'key'),
          );
          result = { id: harness._id.toString(), scope: harness.scope, sections: harness.sections.length };
          break;
        }
        case 'soul_get': {
          const soul = await soulsService.findByOwner({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          result = soul || { message: 'No soul defined yet for this owner. Use soul_update to create one.' };
          break;
        }
        case 'soul_update': {
          const soulFields: Record<string, string> = {};
          for (const key of ['vision', 'principles', 'conventions', 'communication', 'boundaries', 'workflow', 'quality']) {
            const val = optionalString(a, key);
            if (val !== undefined) soulFields[key] = val;
          }
          const soul = await soulsService.upsert(
            {
              projectId: optionalString(a, 'projectId'),
              customerId: optionalString(a, 'customerId'),
            },
            soulFields,
          );
          const soulObj = toPlainDoc(soul.toObject());
          const defined = ['vision', 'principles', 'conventions', 'communication', 'boundaries', 'workflow', 'quality']
            .filter((k) => soulObj[k]).length;
          result = { updated: true, sectionsDefined: `${defined}/7` };
          break;
        }
        case 'commit_list': {
          const commits = await commitsService.findByProject(requireString(a, 'projectId'), {
            branch: optionalString(a, 'branch'),
            author: optionalString(a, 'author'),
            since: optionalString(a, 'since'),
            until: optionalString(a, 'until'),
            provider: optionalString(a, 'provider'),
            repoLabel: optionalString(a, 'repoLabel'),
            limit: optionalNumber(a, 'limit') || 20,
            offset: optionalNumber(a, 'offset'),
          });
          result = commits.map((c) => ({
            sha: c.sha?.substring(0, 8),
            message: c.message?.split('\n')[0]?.substring(0, 120),
            author: c.authorName,
            date: c.committedAt,
            provider: c.provider,
            branch: c.branch,
            repoLabel: c.repoLabel,
          }));
          break;
        }
        case 'commit_search': {
          const found = await commitsService.search(
            requireString(a, 'projectId'),
            requireString(a, 'query'),
            optionalNumber(a, 'limit'),
          );
          result = found.map((c) => ({
            sha: c.sha?.substring(0, 8),
            message: snippet(c.message),
            author: c.authorName,
            date: c.committedAt,
            url: c.url,
          }));
          break;
        }
        case 'commit_sync': {
          const ri = optionalNumber(a, 'repoIndex');
          if (ri !== undefined) {
            result = await commitsService.syncRepository(requireString(a, 'projectId'), ri);
          } else {
            result = await commitsService.syncAllForProject(requireString(a, 'projectId'));
          }
          break;
        }
        case 'rag_search': {
          if (process.env.MCP_STDIO === 'true') {
            const params = new URLSearchParams({ query: requireString(a, 'query') });
            const pid = optionalString(a, 'projectId');
            const cid = optionalString(a, 'customerId');
            const ent = optionalString(a, 'entity');
            const lim = optionalNumber(a, 'limit');
            if (pid) params.set('projectId', pid);
            if (cid) params.set('customerId', cid);
            if (ent) params.set('entity', ent);
            if (lim) params.set('limit', String(lim));
            const ragResults = asObjectArray(await ragHttpGet(`/api/rag/search?${params}`));
            result = ragResults.map((r) => ({
              ...r,
              content: snippet(asString(r.content)),
              score: typeof r.score === 'number' ? Math.round(r.score * 1000) / 1000 : undefined,
            }));
          } else {
            const ragResults = await ragService.search(
              requireString(a, 'query'),
              optionalString(a, 'projectId'),
              optionalString(a, 'entity'),
              optionalNumber(a, 'limit') || 10,
              optionalString(a, 'customerId'),
            );
            result = ragResults.map((r) => ({
              ...r,
              content: snippet(asString(r.content)),
              score: Math.round(r.score * 1000) / 1000,
            }));
          }
          break;
        }
        case 'rag_reindex': {
          if (process.env.MCP_STDIO === 'true') {
            const pid = optionalString(a, 'projectId');
            const cid = optionalString(a, 'customerId');
            const params = new URLSearchParams();
            if (pid) params.set('projectId', pid);
            if (cid) params.set('customerId', cid);
            const qs = params.toString();
            result = await ragHttpPost(`/api/rag/reindex${qs ? `?${qs}` : ''}`);
          } else {
            result = await ragService.reindex(optionalString(a, 'projectId'), optionalString(a, 'customerId'));
          }
          break;
        }
        case 'rag_status': {
          if (process.env.MCP_STDIO === 'true') {
            result = await ragHttpGet('/api/rag/status');
          } else {
            result = await ragService.status();
          }
          break;
        }
        case 'web_search': {
          const query = requireString(a, 'query');
          const language = optionalString(a, 'language');
          // Das Tool-Schema deklariert die Kategorien als Enum; hier wird das
          // jetzt auch durchgesetzt statt nur behauptet.
          const categories = optionalStringArray(a, 'categories')?.map((entry) => {
            const match = SEARCH_CATEGORIES.find((candidate) => candidate === entry);
            if (match === undefined) {
              throw new Error(`categories must contain only: ${SEARCH_CATEGORIES.join(', ')}`);
            }
            return match;
          });
          const timeRange = optionalEnum(a, 'timeRange', SEARCH_TIME_RANGES);
          const limit = optionalNumber(a, 'limit');
          if (process.env.MCP_STDIO === 'true') {
            const params = new URLSearchParams({ q: query });
            if (language) params.set('language', language);
            if (categories?.length) params.set('categories', categories.join(','));
            if (timeRange) params.set('timeRange', timeRange);
            if (limit !== undefined) params.set('limit', String(limit));
            result = await ragHttpGet(`/api/web-search/search?${params}`);
          } else {
            result = await webSearchService.search({
              query,
              language,
              categories,
              timeRange,
              limit,
            });
          }
          break;
        }
        case 'web_fetch': {
          const url = requireString(a, 'url');
          const raw = optionalBoolean(a, 'raw');
          const maxLength = optionalNumber(a, 'maxLength');
          if (process.env.MCP_STDIO === 'true') {
            result = await backendHttpPostJson('/api/web-search/fetch', { url, raw, maxLength });
          } else {
            result = await readabilityService.fetch({ url, raw, maxLength });
          }
          break;
        }
        case 'workspace_create': {
          const ws = await workspacesService.create({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            repoUrl: optionalString(a, 'repoUrl'),
            branch: optionalString(a, 'branch'),
            createdBySessionId: optionalString(a, 'createdBySessionId'),
            gitRepoId: optionalString(a, 'gitRepoId'),
          });
          result = compactCreateResult(ws, { path: ws.path, status: ws.status });
          break;
        }
        case 'workspace_list': {
          const list = await workspacesService.findByProject(
            requireString(a, 'projectId'),
            optionalEnum(a, 'status', WORKSPACE_STATUSES),
          );
          result = compactList(list, ['description']);
          break;
        }
        case 'workspace_get': {
          const id = optionalString(a, 'id');
          if (id) {
            result = await workspacesService.findById(id);
          } else {
            result = await workspacesService.findByName(
              requireString(a, 'projectId'),
              requireString(a, 'name'),
            );
          }
          break;
        }
        case 'workspace_update': {
          result = compactUpdateResult(
            await workspacesService.update(requireString(a, 'id'), {
              name: optionalString(a, 'name'),
              description: optionalString(a, 'description'),
              repoUrl: optionalString(a, 'repoUrl'),
              branch: optionalString(a, 'branch'),
              gitRepoId: optionalString(a, 'gitRepoId'),
            }),
          );
          break;
        }
        case 'workspace_archive': {
          result = compactUpdateResult(await workspacesService.archive(requireString(a, 'id')));
          break;
        }
        case 'workspace_delete': {
          const id = requireString(a, 'id');
          const ws = await workspacesService.findById(id);

          // T-149: backend-enforced confirmation. Skipping ask_user is not
          // an option that the agent can choose — the only path to actually
          // deleting is the user picking the explicit confirm option below.
          // For trusted automation we'll add a per-API-key bypass later.
          const sizeMb = (ws.sizeBytes / (1024 * 1024)).toFixed(1);
          const lastSeen = ws.lastActivityAt ? ws.lastActivityAt.toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
          const CONFIRM = 'Yes, delete permanently';
          const CANCEL = 'Cancel';
          const userId = RequestContext.getUser()?.userId;
          const question = await questionsService.create(
            {
              question: `Workspace "${ws.name}" wirklich unwiderruflich löschen?`,
              options: [CONFIRM, CANCEL],
              context: `Größe: ${sizeMb} MB, zuletzt aktiv: ${lastSeen}, projectId: ${ws.projectId.toString()}`,
              projectId: ws.projectId.toString(),
              timeoutSeconds: 300,
            },
            userId,
          );
          const answer = await questionsService.waitForAnswer(
            question._id.toString(),
            question.timeoutMs,
          );
          if (!answer.answered || answer.answer !== CONFIRM) {
            result = {
              deleted: false,
              aborted: true,
              reason: answer.answered
                ? `user did not confirm (chose "${answer.answer}")`
                : 'confirmation question expired without an answer',
              questionId: question._id.toString(),
            };
            break;
          }

          await workspacesService.remove(id);
          result = { deleted: true, id, confirmedBy: answer.answeredBy };
          break;
        }
        case 'workspace_clone': {
          const id = requireString(a, 'id');
          const ws = await workspacesService.findById(id);
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server));
          // Auto-embed the matching git token in the clone URL so private repos
          // work without manual `oauth2:$TOKEN@host` gymnastics. No-op if URL
          // is already authenticated or no token matches.
          const authenticatedUrl = await workspaceGitTokens.buildAuthenticatedCloneUrl(
            ws,
            requireString(a, 'repoUrl'),
          );
          const sidecar = await workspaceClient.clone(
            ws._id.toString(),
            authenticatedUrl,
            optionalString(a, 'branch'),
          );
          // Pull a fresh size after clone so the UI reflects disk usage.
          let sizeBytes: number | undefined;
          try {
            const sizeRes = await workspaceClient.size(ws._id.toString());
            sizeBytes = sizeRes.sizeBytes;
          } catch {
            sizeBytes = undefined;
          }
          await workspacesService.touch(id, sizeBytes);
          result = { cloned: true, id, sizeBytes, sidecar };
          break;
        }
        case 'workspace_pull': {
          const id = requireString(a, 'id');
          const ws = await workspacesService.findById(id);
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server));
          const sidecar = await workspaceClient.pull(ws._id.toString());
          await workspacesService.touch(id);
          result = { pulled: true, id, sidecar };
          break;
        }
        case 'workspace_tree': {
          const id = requireString(a, 'id');
          const ws = await workspacesService.findById(id);
          const path = optionalString(a, 'path');
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server), { relativePath: path });
          const tree = await workspaceClient.tree(
            ws._id.toString(),
            path,
            optionalNumber(a, 'depth'),
          );
          await workspacesService.touch(id);
          result = tree;
          break;
        }
        case 'workspace_read': {
          const id = requireString(a, 'id');
          const ws = await workspacesService.findById(id);
          const path = requireString(a, 'path');
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server), { relativePath: path });
          const file = await workspaceClient.read(ws._id.toString(), path);
          await workspacesService.touch(id);
          result = file;
          break;
        }
        case 'workspace_search': {
          const id = requireString(a, 'id');
          const ws = await workspacesService.findById(id);
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server));
          const search = await workspaceClient.search(
            ws._id.toString(),
            requireString(a, 'query'),
            optionalStringArray(a, 'include'),
            optionalStringArray(a, 'exclude'),
          );
          await workspacesService.touch(id);
          result = search;
          break;
        }
        case 'workspace_status': {
          const id = requireString(a, 'id');
          const ws = await workspacesService.findById(id);
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server));
          const status = await workspaceClient.status(ws._id.toString());
          await workspacesService.touch(id);
          result = status;
          break;
        }
        case 'workspace_exec': {
          const id = requireString(a, 'id');
          const command = requireString(a, 'command');
          const timeoutMs = optionalNumber(a, 'timeout');
          const callerEnv = optionalObject<Record<string, string>>(a, 'env');
          const ws = await workspacesService.findById(id);
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server));
          // Auto-inject GH_TOKEN/GITLAB_TOKEN/GITLAB_HOST from project.gitRepositories
          // so `gh`/`glab` work inside the sidecar without manual auth. Caller env wins.
          const gitEnv = await workspaceGitTokens.resolveForWorkspace(ws);
          // Auto-inject DG_* so the in-workspace `dg` CLI talks to the backend
          // with a project-scoped token (1h TTL, T-168).
          const dgEnv = workspaceCliToken.buildEnvFor(ws._id.toString(), ws.projectId.toString());
          const mergedEnv = Object.keys(gitEnv).length || Object.keys(dgEnv).length || callerEnv
            ? { ...gitEnv, ...dgEnv, ...(callerEnv ?? {}) }
            : undefined;
          const exec = await workspaceClient.exec(ws._id.toString(), command, timeoutMs, mergedEnv);
          await workspacesService.touch(id);

          // Audit log — best-effort, never blocks the exec response.
          logsService
            .create({
              projectId: ws.projectId.toString(),
              level: exec.exitCode === 0 ? 'info' : 'warn',
              message: `workspace_exec ${exec.timedOut ? 'TIMED OUT' : `exit=${exec.exitCode}`} (${exec.durationMs}ms): ${command.slice(0, 200)}`,
              service: 'workspaces',
              area: 'exec',
              tags: ['workspace_exec', `ws:${id}`],
              metadata: {
                workspaceId: id,
                command,
                exitCode: exec.exitCode,
                signal: exec.signal,
                timedOut: exec.timedOut,
                durationMs: exec.durationMs,
                stdoutTruncated: exec.stdoutTruncated,
                stderrTruncated: exec.stderrTruncated,
              },
            })
            .catch((err: unknown) => {
              console.warn(
                'workspace_exec audit log failed',
                err instanceof Error ? err.message : String(err),
              );
            });

          result = exec;
          break;
        }
        case 'workspace_attachment_save': {
          const id = requireString(a, 'id');
          const path = requireString(a, 'path');
          const ws = await workspacesService.findById(id);
          assertWorkspaceWithinClientRoots(ws, await getClientRoots(server), { relativePath: path });

          // Binary-safe read so non-text artefacts (zip/png/apk) round-trip
          // through MinIO without UTF-8 mangling.
          const file = await workspaceClient.readBase64(ws._id.toString(), path);

          const fileName = optionalString(a, 'fileName')
            || path.split('/').filter(Boolean).pop()
            || 'file';
          const tags = Array.isArray(a.tags)
            ? (a.tags as unknown[]).filter((t): t is string => typeof t === 'string')
            : undefined;

          const attachment = await attachmentsService.createFromBase64(
            {
              projectId: ws.projectId.toString(),
              fileName,
              entityType: optionalString(a, 'entityType'),
              entityId: optionalString(a, 'entityId'),
              description: optionalString(a, 'description'),
              tags,
            },
            file.contentBase64,
          );
          await workspacesService.touch(id);
          result = {
            saved: true,
            attachmentId: attachment._id.toString(),
            fileName,
            sizeBytes: file.size,
          };
          break;
        }
        case 'ssh_connection_list': {
          const projectId = optionalString(a, 'projectId');
          const customerId = optionalString(a, 'customerId');
          if (!projectId && !customerId) {
            throw new Error('scope_required');
          }
          const tags = optionalStringArray(a, 'tags');
          const docs = await sshService.findByScopeAndTags({ projectId, customerId, tags });
          result = docs.map((d) => serializeSshConnectionForMcp(d));
          break;
        }
        case 'ssh_connection_get': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'id'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const latest = await sshService.findLatestAudit(conn._id.toString());
          result = {
            ...serializeSshConnectionForMcp(conn),
            lastAuditEntry: latest ? serializeSshAuditForMcp(latest) : null,
          };
          break;
        }
        case 'ssh_exec': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'connectionId'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const command = requireString(a, 'command');
          const timeoutMs = optionalNumber(a, 'timeoutMs');
          const idleTimeoutMs = optionalNumber(a, 'idleTimeoutMs');
          const cwd = optionalString(a, 'cwd');
          const envObj = optionalObject(a, 'env');
          let env: Record<string, string> | undefined;
          if (envObj) {
            env = {};
            for (const [k, v] of Object.entries(envObj)) {
              if (typeof v === 'string') env[k] = v;
            }
          }
          // requireUserId throws if neither auth context nor MCP_STDIO_USER_ID
          // is set — that's correct for write-tier SSH ops because the audit
          // row would otherwise be userId-less and fail validation.
          const userId = requireUserId();
          result = await sshSessionService.exec(conn._id.toString(), command, {
            timeoutMs,
            idleTimeoutMs,
            env,
            cwd,
            sourceContext: 'mcp',
            userId,
          });
          break;
        }
        case 'ssh_upload': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'connectionId'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const remotePath = requireString(a, 'remotePath');
          const content = requireString(a, 'content');
          const encoding = optionalString(a, 'encoding') ?? 'utf-8';
          if (encoding !== 'utf-8' && encoding !== 'base64') {
            throw new Error(`encoding must be 'utf-8' or 'base64' (got ${encoding})`);
          }
          // Pre-decode size cap against the connection's EFFECTIVE limit
          // (global setting > per-connection override > 10 MB default, clamped
          // to 500 MB). `content.length` is a safe upper bound on the decoded
          // buffer, so oversize strings are rejected before spending decode RAM.
          // For base64 we use the tighter (limit * 4/3 + padding) string cap.
          // The post-decode check stays as a second line of defense, and
          // sftpUpload re-checks the decoded buffer against the same limit.
          const rawLimit = await settingsService.get('ssh.maxUploadBytes');
          const parsedLimit = rawLimit !== null ? Number.parseInt(rawLimit, 10) : NaN;
          const effectiveLimit = computeEffectiveUploadLimit(
            Number.isNaN(parsedLimit) ? null : parsedLimit,
            conn.maxUploadBytes,
          );
          const BASE64_PRE_MAX = Math.ceil((effectiveLimit * 4) / 3) + 4;
          if (encoding === 'utf-8' && content.length > effectiveLimit) {
            throw new Error(`upload_too_large: utf-8 content length ${content.length} exceeds ${effectiveLimit} bytes`);
          }
          if (encoding === 'base64' && content.length > BASE64_PRE_MAX) {
            throw new Error(`upload_too_large: base64 input length ${content.length} would decode beyond ${effectiveLimit} bytes`);
          }
          // Strict decode: the lenient Buffer.from(str,'base64') would swallow
          // a dropped/garbled character and produce plausible-but-wrong bytes,
          // which is exactly how an inline upload silently corrupts a file.
          const buf = encoding === 'base64'
            ? decodeBase64Strict(content)
            : Buffer.from(content, 'utf8');
          if (buf.length > effectiveLimit) {
            throw new Error(`upload_too_large: decoded length ${buf.length} exceeds ${effectiveLimit} bytes`);
          }
          // Verified before any remote handle is opened, so a mismatch never
          // leaves a truncated file behind.
          const expectedSha256 = optionalString(a, 'sha256');
          if (expectedSha256 !== undefined) {
            assertSha256Matches(expectedSha256, buf);
          }
          const mode = optionalNumber(a, 'mode');
          const createDirs = optionalBoolean(a, 'createDirs');
          const append = optionalBoolean(a, 'append');
          const userId = requireUserId();
          result = await sshSessionService.sftpUpload(conn._id.toString(), remotePath, buf, {
            mode,
            createDirs,
            append,
            sourceContext: 'mcp',
            userId,
          });
          break;
        }
        case 'ssh_upload_from_attachment': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'connectionId'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const attachmentId = requireString(a, 'attachmentId');
          const remotePath = requireString(a, 'remotePath');
          const mode = optionalNumber(a, 'mode');
          const createDirs = optionalBoolean(a, 'createDirs');
          const userId = requireUserId();
          const { stream, attachment } = await attachmentsService.download(attachmentId);
          result = await sshSessionService.sftpUploadStream(
            conn._id.toString(),
            remotePath,
            stream,
            {
              mode,
              createDirs,
              sourceContext: 'mcp',
              userId,
              expectedSize: attachment.size,
            },
          );
          break;
        }
        case 'ssh_upload_from_workspace': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'connectionId'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const workspaceId = requireString(a, 'workspaceId');
          const sourcePath = requireString(a, 'sourcePath');
          const remotePath = requireString(a, 'remotePath');
          const mode = optionalNumber(a, 'mode');
          const createDirs = optionalBoolean(a, 'createDirs');
          const userId = requireUserId();
          // Ownership check against the local DB before hitting the sidecar
          // (the sidecar only enforces format-level path safety).
          const ws = await workspacesService.findById(workspaceId);
          const { stream, size } = await workspaceClient.readStream(
            ws._id.toString(),
            sourcePath,
          );
          result = await sshSessionService.sftpUploadStream(
            conn._id.toString(),
            remotePath,
            stream,
            {
              mode,
              createDirs,
              sourceContext: 'mcp',
              userId,
              expectedSize: size || undefined,
            },
          );
          break;
        }
        case 'ssh_download': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'connectionId'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const remotePath = requireString(a, 'remotePath');
          const maxBytes = optionalNumber(a, 'maxBytes');
          const requestedEncoding = optionalString(a, 'encoding') ?? 'utf-8';
          if (requestedEncoding !== 'utf-8' && requestedEncoding !== 'base64') {
            throw new Error(`encoding must be 'utf-8' or 'base64' (got ${requestedEncoding})`);
          }
          const userId = requireUserId();
          const dl = await sshSessionService.sftpDownload(conn._id.toString(), remotePath, {
            maxBytes,
            sourceContext: 'mcp',
            userId,
          });
          // Binary detection: when caller asked for utf-8, downgrade to
          // base64 if the buffer isn't round-trip-safe (null byte or invalid
          // UTF-8 sequence). When caller asked for base64, honour that.
          const effectiveEncoding: 'utf-8' | 'base64' =
            requestedEncoding === 'base64' || !isUtf8RoundTripSafe(dl.content)
              ? 'base64'
              : 'utf-8';
          const contentStr = effectiveEncoding === 'base64'
            ? dl.content.toString('base64')
            : dl.content.toString('utf8');
          result = {
            content: contentStr,
            encoding: effectiveEncoding,
            bytesRead: dl.bytesRead,
            truncated: dl.truncated,
          };
          break;
        }
        case 'ssh_exec_async': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'connectionId'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const command = requireString(a, 'command');
          const timeoutMs = optionalNumber(a, 'timeoutMs');
          const idleTimeoutMs = optionalNumber(a, 'idleTimeoutMs');
          const cwd = optionalString(a, 'cwd');
          const envObj = optionalObject(a, 'env');
          let env: Record<string, string> | undefined;
          if (envObj) {
            env = {};
            for (const [k, v] of Object.entries(envObj)) {
              if (typeof v === 'string') env[k] = v;
            }
          }
          const userId = requireUserId();
          result = await sshSessionService.execAsync(conn._id.toString(), command, {
            timeoutMs,
            idleTimeoutMs,
            env,
            cwd,
            sourceContext: 'mcp',
            userId,
          });
          break;
        }
        case 'ssh_exec_status': {
          const jobId = requireString(a, 'jobId');
          const snap = sshSessionService.getJobStatus(jobId);
          if (!snap) throw new Error('job_not_found');
          result = snap;
          break;
        }
        case 'ssh_exec_cancel': {
          const jobId = requireString(a, 'jobId');
          const snap = sshSessionService.cancelJob(jobId);
          if (!snap) throw new Error('job_not_found');
          result = snap;
          break;
        }
        case 'ssh_list_files': {
          const conn = await resolveSshConnection(sshService, {
            id: optionalString(a, 'connectionId'),
            slug: optionalString(a, 'slug'),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
          });
          const remotePath = requireString(a, 'remotePath');
          const recursive = optionalBoolean(a, 'recursive');
          const maxEntries = optionalNumber(a, 'maxEntries');
          const userId = requireUserId();
          result = await sshSessionService.listFiles(conn._id.toString(), remotePath, {
            recursive,
            maxEntries,
            sourceContext: 'mcp',
            userId,
          });
          break;
        }
        case 'recurring_task_create': {
          const rt = await recurringTasksService.create({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            title: requireString(a, 'title'),
            description: optionalString(a, 'description'),
            priority: optionalString(a, 'priority'),
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            repoLabel: optionalString(a, 'repoLabel'),
            frequency: requireEnum(a, 'frequency', Object.values(RecurringFrequency)),
            dayOfWeek: optionalNumber(a, 'dayOfWeek'),
            dayOfMonth: optionalNumber(a, 'dayOfMonth'),
            month: optionalNumber(a, 'month'),
            hour: optionalNumber(a, 'hour'),
            maxCatchUp: optionalNumber(a, 'maxCatchUp'),
          });
          result = compactCreateResult(rt, { nextRun: rt.nextRun });
          break;
        }
        case 'recurring_task_list': {
          const rts = await recurringTasksService.findAll({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            systemOnly: optionalBoolean(a, 'systemOnly'),
            active: optionalBoolean(a, 'active'),
          });
          result = compactList(rts, ['description', 'createdTodoIds']);
          break;
        }
        case 'recurring_task_get': {
          result = await recurringTasksService.findById(requireString(a, 'id'));
          break;
        }
        case 'recurring_task_update': {
          const updated = await recurringTasksService.update(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            description: optionalString(a, 'description'),
            priority: optionalString(a, 'priority'),
            tags: optionalStringArray(a, 'tags'),
            milestoneId: optionalString(a, 'milestoneId'),
            repoLabel: optionalString(a, 'repoLabel'),
            frequency: optionalEnum(a, 'frequency', Object.values(RecurringFrequency)),
            dayOfWeek: optionalNumber(a, 'dayOfWeek'),
            dayOfMonth: optionalNumber(a, 'dayOfMonth'),
            month: optionalNumber(a, 'month'),
            hour: optionalNumber(a, 'hour'),
            active: optionalBoolean(a, 'active'),
            maxCatchUp: optionalNumber(a, 'maxCatchUp'),
          });
          result = compactUpdateResult(updated);
          break;
        }
        case 'recurring_task_delete': {
          await recurringTasksService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        }
        case 'validation_report_add': {
          const report = await validationReportsService.create({
            projectId: requireString(a, 'projectId'),
            todoId: optionalString(a, 'todoId'),
            commitId: optionalString(a, 'commitId'),
            workflowRunId: optionalString(a, 'workflowRunId'),
            name: requireString(a, 'name'),
            command: optionalString(a, 'command'),
            status: requireEnum(a, 'status', Object.values(ValidationReportStatus)),
            exitCode: optionalNumber(a, 'exitCode'),
            durationMs: optionalNumber(a, 'durationMs'),
            summary: optionalString(a, 'summary'),
            outputSnippet: optionalString(a, 'outputSnippet'),
            tags: optionalStringArray(a, 'tags'),
            metadata: optionalObject(a, 'metadata'),
          });
          result = compactCreateResult(report, { status: report.status });
          break;
        }
        case 'validation_report_list': {
          const reports = await validationReportsService.list({
            projectId: optionalString(a, 'projectId'),
            todoId: optionalString(a, 'todoId'),
            commitId: optionalString(a, 'commitId'),
            workflowRunId: optionalString(a, 'workflowRunId'),
            status: optionalEnum(a, 'status', Object.values(ValidationReportStatus)),
            limit: optionalNumber(a, 'limit'),
          });
          result = compactList(reports, ['outputSnippet', 'metadata', '__v']);
          break;
        }
        case 'validation_report_get': {
          result = await validationReportsService.findById(requireString(a, 'id'));
          break;
        }
        case 'validation_report_propose_bug_todo': {
          const outcome = await validationReportsService.proposeBugTodo(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            priority: optionalEnum(a, 'priority', Object.values(TodoPriority)),
            milestoneId: optionalString(a, 'milestoneId'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = {
            todoId: outcome.todo._id.toString(),
            displayNumber: outcome.todo.displayNumber,
            reused: outcome.reused,
            reportId: outcome.report._id.toString(),
          };
          break;
        }
        case 'doc_update_proposal_list': {
          const proposals = await docUpdateProposalsService.list({
            projectId: optionalString(a, 'projectId'),
            status: optionalEnum(a, 'status', Object.values(DocProposalStatus)),
            sourceType: optionalEnum(a, 'sourceType', Object.values(DocProposalSourceType)),
            sourceId: optionalString(a, 'sourceId'),
            targetType: optionalEnum(a, 'targetType', Object.values(DocProposalTargetType)),
            targetId: optionalString(a, 'targetId'),
            limit: optionalNumber(a, 'limit'),
          });
          result = compactList(proposals, ['metadata', '__v', 'suggestedChange']);
          break;
        }
        case 'doc_update_proposal_get': {
          result = await docUpdateProposalsService.findById(requireString(a, 'id'));
          break;
        }
        case 'doc_update_proposal_create': {
          const proposal = await docUpdateProposalsService.create({
            projectId: requireString(a, 'projectId'),
            source: requireObject(a, 'source'),
            target: requireObject(a, 'target'),
            reason: requireString(a, 'reason'),
            confidence: requireNumber(a, 'confidence'),
            suggestedChange: requireObject(a, 'suggestedChange'),
            createdBy: optionalEnum(a, 'createdBy', ENTITY_CREATORS),
            metadata: optionalObject(a, 'metadata'),
          });
          result = compactCreateResult(proposal, { status: proposal.status });
          break;
        }
        case 'doc_update_proposal_update_status': {
          const updated = await docUpdateProposalsService.updateStatus(
            requireString(a, 'id'),
            requireEnum(a, 'status', Object.values(DocProposalStatus)),
            optionalString(a, 'note'),
          );
          result = { id: updated._id.toString(), status: updated.status };
          break;
        }
        case 'doc_update_proposal_convert_to_todo': {
          const outcome = await docUpdateProposalsService.convertToTodo(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            priority: optionalEnum(a, 'priority', TODO_PRIORITY_LITERALS),
            milestoneId: optionalString(a, 'milestoneId'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = {
            todoId: outcome.todo._id.toString(),
            displayNumber: outcome.todo.displayNumber,
            reused: outcome.reused,
            proposalId: outcome.proposal._id.toString(),
          };
          break;
        }
        case 'knowledge_graph_neighbors': {
          const edges = await knowledgeGraphService.neighbors(
            requireString(a, 'projectId'),
            requireEnum(a, 'entityType', KG_ENTITY_TYPES),
            requireString(a, 'entityId'),
          );
          result = edges.map((e) => e.toObject());
          break;
        }
        case 'knowledge_graph_impact': {
          result = await knowledgeGraphService.impact(
            requireString(a, 'projectId'),
            requireEnum(a, 'entityType', KG_ENTITY_TYPES),
            requireString(a, 'entityId'),
            optionalNumber(a, 'depth'),
          );
          break;
        }
        case 'knowledge_graph_link': {
          const edge = await knowledgeGraphService.create({
            projectId: requireString(a, 'projectId'),
            source: requireObject(a, 'source'),
            target: requireObject(a, 'target'),
            relation: requireEnum(a, 'relation', KG_RELATIONS),
            weight: optionalNumber(a, 'weight'),
            confidence: optionalNumber(a, 'confidence'),
            direction: optionalEnum(a, 'direction', KG_EDGE_DIRECTIONS),
            createdBy: optionalEnum(a, 'createdBy', ENTITY_CREATORS),
            metadata: optionalObject(a, 'metadata'),
          });
          result = compactCreateResult(edge, { relation: edge.relation });
          break;
        }
        case 'knowledge_graph_discover': {
          result = await knowledgeGraphService.discoverForProject(requireString(a, 'projectId'));
          break;
        }
        case 'knowledge_graph_list': {
          const edges = await knowledgeGraphService.list({
            projectId: optionalString(a, 'projectId'),
            entityType: optionalEnum(a, 'entityType', KG_ENTITY_TYPES),
            entityId: optionalString(a, 'entityId'),
            relation: optionalEnum(a, 'relation', KG_RELATIONS),
            limit: optionalNumber(a, 'limit'),
          });
          result = compactList(edges, ['metadata', '__v']);
          break;
        }
        case 'oracle_analyze': {
          result = await oracleService.analyze(requireString(a, 'projectId'));
          break;
        }
        case 'oracle_list': {
          const suggestions = await oracleService.list({
            projectId: optionalString(a, 'projectId'),
            status: optionalEnum(a, 'status', Object.values(OracleSuggestionStatus)),
            severity: optionalEnum(a, 'severity', Object.values(OracleSeverity)),
            type: optionalEnum(a, 'type', Object.values(OracleRiskType)),
            limit: optionalNumber(a, 'limit'),
          });
          result = compactList(suggestions, ['metadata', '__v']);
          break;
        }
        case 'oracle_get': {
          result = await oracleService.findById(requireString(a, 'id'));
          break;
        }
        case 'oracle_update_status': {
          const updated = await oracleService.updateStatus(
            requireString(a, 'id'),
            requireEnum(a, 'status', Object.values(OracleSuggestionStatus)),
            optionalString(a, 'note'),
          );
          result = { id: updated._id.toString(), status: updated.status };
          break;
        }
        case 'oracle_convert_to_todo': {
          const outcome = await oracleService.convertToTodo(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            priority: optionalEnum(a, 'priority', TODO_PRIORITY_LITERALS),
            milestoneId: optionalString(a, 'milestoneId'),
            tags: optionalStringArray(a, 'tags'),
          });
          result = {
            todoId: outcome.todo._id.toString(),
            displayNumber: outcome.todo.displayNumber,
            reused: outcome.reused,
            suggestionId: outcome.suggestion._id.toString(),
          };
          break;
        }
        case 'oracle_comment_on_todo': {
          const outcome = await oracleService.commentOnTodo(requireString(a, 'id'), {
            todoId: optionalString(a, 'todoId'),
            note: optionalString(a, 'note'),
          });
          result = {
            suggestionId: outcome.suggestion._id.toString(),
            todoId: outcome.todoId,
            commented: outcome.commented,
            status: outcome.suggestion.status,
          };
          break;
        }
        case 'workflow_create': {
          const wf = await workflowsService.createDefinition({
            scope: requireEnum(a, 'scope', Object.values(WorkflowScope)),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            tags: optionalStringArray(a, 'tags'),
            trigger: optionalObject(a, 'trigger'),
            nodes: optionalObjectArray<WorkflowNodeDto>(a, 'nodes'),
            edges: optionalObjectArray<WorkflowEdgeDto>(a, 'edges'),
            ui: optionalObject(a, 'ui'),
          });
          result = { id: wf._id.toString(), version: wf.version, status: wf.status };
          break;
        }
        case 'workflow_list': {
          const list = await workflowsService.listDefinitions({
            scope: optionalEnum(a, 'scope', Object.values(WorkflowScope)),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            status: optionalEnum(a, 'status', Object.values(WorkflowStatus)),
            tag: optionalString(a, 'tag'),
            includeArchived: typeof a.includeArchived === 'boolean' ? a.includeArchived : undefined,
            limit: optionalNumber(a, 'limit'),
            offset: optionalNumber(a, 'offset'),
          });
          result = list.map((w) => ({
            id: w._id.toString(),
            name: w.name,
            scope: w.scope,
            status: w.status,
            version: w.version,
            tags: w.tags,
            projectId: w.projectId?.toString(),
            customerId: w.customerId?.toString(),
            updatedAt: w.updatedAt,
          }));
          break;
        }
        case 'workflow_get': {
          const wf = await workflowsService.getDefinition(requireString(a, 'id'));
          result = wf.toObject();
          break;
        }
        case 'workflow_update': {
          const updated = await workflowsService.updateDefinition(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            status: optionalEnum(a, 'status', Object.values(WorkflowStatus)),
            tags: optionalStringArray(a, 'tags'),
            trigger: optionalObject(a, 'trigger'),
            nodes: optionalObjectArray<WorkflowNodeDto>(a, 'nodes'),
            edges: optionalObjectArray<WorkflowEdgeDto>(a, 'edges'),
            ui: optionalObject(a, 'ui'),
            publish: typeof a.publish === 'boolean' ? a.publish : undefined,
          });
          result = { id: updated._id.toString(), version: updated.version, status: updated.status };
          break;
        }
        case 'workflow_delete': {
          await workflowsService.deleteDefinition(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        }
        case 'workflow_validate': {
          const id = optionalString(a, 'id');
          if (id) {
            const def = await workflowsService.getDefinition(id);
            result = workflowsService.validateGraph({
              scope: def.scope,
              projectId: def.projectId?.toString(),
              customerId: def.customerId?.toString(),
              nodes: def.nodes,
              edges: def.edges,
            });
          } else {
            result = workflowsService.validateGraph({
              scope: optionalEnum(a, 'scope', Object.values(WorkflowScope)),
              projectId: optionalString(a, 'projectId'),
              customerId: optionalString(a, 'customerId'),
              nodes: optionalObjectArray<WorkflowNodeDto>(a, 'nodes'),
              edges: optionalObjectArray<WorkflowEdgeDto>(a, 'edges'),
            });
          }
          break;
        }
        case 'workflow_run_start': {
          const run = await workflowsService.startRun({
            definitionId: requireString(a, 'definitionId'),
            trigger: optionalObject(a, 'trigger'),
            input: optionalObject(a, 'input'),
          });
          result = {
            id: run._id.toString(),
            definitionId: run.definitionId.toString(),
            definitionVersion: run.definitionVersion,
            status: run.status,
          };
          break;
        }
        case 'workflow_run_list': {
          const runs = await workflowsService.listRuns({
            definitionId: optionalString(a, 'definitionId'),
            scope: optionalEnum(a, 'scope', Object.values(WorkflowScope)),
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            status: optionalString(a, 'status'),
            limit: optionalNumber(a, 'limit'),
            offset: optionalNumber(a, 'offset'),
          });
          result = runs.map((r) => ({
            id: r._id.toString(),
            definitionId: r.definitionId.toString(),
            definitionVersion: r.definitionVersion,
            status: r.status,
            scope: r.scope,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            createdAt: r.createdAt,
          }));
          break;
        }
        case 'workflow_run_get': {
          const run = await workflowsService.getRun(requireString(a, 'id'));
          result = run.toObject();
          break;
        }
        case 'workflow_run_inspect': {
          result = await workflowsService.inspectRun(requireString(a, 'id'));
          break;
        }
        case 'workflow_run_cancel': {
          const run = await workflowsService.cancelRun(requireString(a, 'id'), {
            reason: optionalString(a, 'reason'),
          });
          result = { id: run._id.toString(), status: run.status, finishedAt: run.finishedAt };
          break;
        }
        case 'workflow_run_retry': {
          const id = requireString(a, 'id');
          await workflowEngineService.retryRun(id, optionalString(a, 'fromNodeId'));
          result = { ok: true, id };
          break;
        }
        case 'workflow_node_test': {
          result = await workflowEngineService.testNode({
            node: requireObject(a, 'node'),
            scope: optionalEnum(a, 'scope', Object.values(WorkflowScope)),
            input: optionalObject(a, 'input'),
            runContext: optionalObject(a, 'runContext'),
          });
          break;
        }
        case 'workflow_node_run_list': {
          const nodeRuns = await workflowsService.listNodeRuns(requireString(a, 'runId'));
          result = nodeRuns.map((nr) => ({
            id: nr._id.toString(),
            nodeId: nr.nodeId,
            nodeType: nr.nodeType,
            status: nr.status,
            attempt: nr.attempt,
            startedAt: nr.startedAt,
            finishedAt: nr.finishedAt,
            durationMs: nr.durationMs,
          }));
          break;
        }
        case 'workflow_node_types_list': {
          const { toPublicMetadata } = await import('./workflows/engine/node-metadata');
          result = nodeRegistry.listMetadata().map(toPublicMetadata);
          break;
        }
        case 'customer_template_create': {
          const tpl = await customerTemplatesService.create({
            name: requireString(a, 'name'),
            slug: requireString(a, 'slug'),
            description: optionalString(a, 'description'),
            type: requireEnum(a, 'type', Object.values(CustomerTemplateType)),
            active: typeof a.active === 'boolean' ? a.active : undefined,
            tags: optionalStringArray(a, 'tags'),
            items: optionalObjectArray<CustomerTemplateItemDto>(a, 'items'),
          });
          result = { id: tpl._id.toString(), slug: tpl.slug, version: tpl.version };
          break;
        }
        case 'customer_template_list': {
          const list = await customerTemplatesService.list({
            type: optionalEnum(a, 'type', Object.values(CustomerTemplateType)),
            active: typeof a.active === 'boolean' ? a.active : undefined,
            tag: optionalString(a, 'tag'),
          });
          result = list.map((t) => ({
            id: t._id.toString(),
            name: t.name,
            slug: t.slug,
            type: t.type,
            active: t.active,
            version: t.version,
            tags: t.tags,
            itemCount: t.items.length,
            updatedAt: t.updatedAt,
          }));
          break;
        }
        case 'customer_template_get': {
          const tpl = await customerTemplatesService.findById(requireString(a, 'id'));
          result = tpl.toObject();
          break;
        }
        case 'customer_template_update': {
          const updated = await customerTemplatesService.update(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            type: optionalEnum(a, 'type', Object.values(CustomerTemplateType)),
            active: typeof a.active === 'boolean' ? a.active : undefined,
            tags: optionalStringArray(a, 'tags'),
            items: optionalObjectArray<CustomerTemplateItemDto>(a, 'items'),
            publish: typeof a.publish === 'boolean' ? a.publish : undefined,
          });
          result = { id: updated._id.toString(), version: updated.version };
          break;
        }
        case 'customer_template_delete': {
          await customerTemplatesService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        }
        case 'customer_template_preview': {
          result = await customerTemplatesService.preview(
            requireString(a, 'id'),
            requireString(a, 'customerId'),
          );
          break;
        }
        case 'customer_template_apply': {
          result = await customerTemplatesService.apply(requireString(a, 'id'), {
            customerId: requireString(a, 'customerId'),
          });
          break;
        }
        case 'snippet_save': {
          const snip = await snippetsService.create({
            projectId: optionalString(a, 'projectId'),
            customerId: optionalString(a, 'customerId'),
            title: requireString(a, 'title'),
            language: requireString(a, 'language'),
            code: requireString(a, 'code'),
            description: optionalString(a, 'description'),
            tags: optionalStringArray(a, 'tags'),
            category: optionalString(a, 'category'),
            fileName: optionalString(a, 'fileName'),
          });
          result = compactCreateResult(snip, { title: snip.title });
          break;
        }
        case 'snippet_list': {
          const sProjectId = optionalString(a, 'projectId');
          const sCustomerId = optionalString(a, 'customerId');
          if (!sProjectId && !sCustomerId) {
            throw new Error('snippet_list requires projectId or customerId');
          }
          const snippets = sProjectId
            ? await snippetsService.findByProject(
                sProjectId,
                optionalString(a, 'language'),
                optionalString(a, 'category'),
                optionalString(a, 'tag'),
              )
            : await snippetsService.findByCustomer(
                sCustomerId!,
                optionalString(a, 'language'),
                optionalString(a, 'category'),
                optionalString(a, 'tag'),
              );
          result = applyPagination(
            compactList(snippets, ['code', 'description', '__v']),
            optionalNumber(a, 'limit'),
            optionalNumber(a, 'offset'),
          );
          break;
        }
        case 'snippet_get':
          result = await snippetsService.findById(requireString(a, 'id'));
          break;
        case 'snippet_update':
          result = compactUpdateResult(await snippetsService.update(requireString(a, 'id'), {
            title: optionalString(a, 'title'),
            language: optionalString(a, 'language'),
            code: optionalString(a, 'code'),
            description: optionalString(a, 'description'),
            tags: optionalStringArray(a, 'tags'),
            category: optionalString(a, 'category'),
            fileName: optionalString(a, 'fileName'),
          }));
          break;
        case 'snippet_delete':
          await snippetsService.remove(requireString(a, 'id'));
          result = { deleted: true, id: requireString(a, 'id') };
          break;
        case 'snippet_search': {
          const searchResults = await snippetsService.search(
            requireString(a, 'q'),
            optionalString(a, 'projectId'),
            optionalString(a, 'customerId'),
          );
          result = searchResults.map((s) => {
            const obj = toPlainDoc(s);
            obj.code = snippet(asString(obj.code));
            obj.description = snippet(asString(obj.description));
            delete obj.__v;
            return obj;
          });
          break;
        }
        // ── Attachments ────────────────────────────────────────
        case 'attachment_upload': {
          const attachment = await attachmentsService.createFromBase64(
            {
              projectId: optionalString(a, 'projectId'),
              customerId: optionalString(a, 'customerId'),
              fileName: requireString(a, 'fileName'),
              mimeType: optionalString(a, 'mimeType'),
              entityType: optionalString(a, 'entityType'),
              entityId: optionalString(a, 'entityId'),
              description: optionalString(a, 'description'),
              tags: optionalStringArray(a, 'tags'),
            },
            requireString(a, 'content'),
          );
          result = compactCreateResult(attachment, {
            originalName: attachment.originalName,
            size: attachment.size,
            mimeType: attachment.mimeType,
          });
          break;
        }
        case 'attachment_list': {
          const attProjectId = optionalString(a, 'projectId');
          const attCustomerId = optionalString(a, 'customerId');
          if (!attProjectId && !attCustomerId) {
            throw new Error('attachment_list requires projectId or customerId');
          }
          const items = attCustomerId
            ? await attachmentsService.findByCustomer(
                attCustomerId,
                optionalString(a, 'entityType'),
                optionalString(a, 'entityId'),
              )
            : await attachmentsService.findByProject(
                attProjectId!,
                optionalString(a, 'entityType'),
                optionalString(a, 'entityId'),
              );
          result = applyPagination(
            compactList(items, ['textContent', '__v']),
            optionalNumber(a, 'limit') ?? 50,
            optionalNumber(a, 'offset') ?? 0,
          );
          break;
        }
        case 'attachment_get': {
          const att = await attachmentsService.findById(requireString(a, 'id'));
          result = att;
          break;
        }
        case 'attachment_download': {
          const { buffer, attachment: att } = await attachmentsService.getContent(requireString(a, 'id'));
          const MAX_DOWNLOAD = 5 * 1024 * 1024;
          if (buffer.length > MAX_DOWNLOAD) {
            result = {
              originalName: att.originalName,
              mimeType: att.mimeType,
              size: att.size,
              error: `File too large for MCP download (${(att.size / 1024 / 1024).toFixed(1)}MB). Use the REST API: GET /api/attachments/${idToString(att._id) ?? ''}/download`,
            };
          } else if (att.mimeType.startsWith('text/') || ['application/json', 'application/javascript', 'application/typescript', 'application/xml', 'application/x-yaml', 'application/x-sh'].includes(att.mimeType)) {
            result = {
              originalName: att.originalName,
              mimeType: att.mimeType,
              size: att.size,
              content: buffer.toString('utf-8'),
            };
          } else {
            result = {
              originalName: att.originalName,
              mimeType: att.mimeType,
              size: att.size,
              contentBase64: buffer.toString('base64'),
            };
          }
          break;
        }
        case 'attachment_delete': {
          await attachmentsService.remove(requireString(a, 'id'));
          result = { deleted: true };
          break;
        }
        case 'log_list': {
          const logs = await logsService.findByProject(requireString(a, 'projectId'), {
            level: optionalString(a, 'level'),
            service: optionalString(a, 'service'),
            search: optionalString(a, 'search'),
            startDate: optionalString(a, 'startDate'),
            endDate: optionalString(a, 'endDate'),
            limit: optionalNumber(a, 'limit'),
            offset: optionalNumber(a, 'offset'),
          });
          result = logs.map((l) => ({
            _id: l._id,
            level: l.level,
            message: snippet(l.message, 300),
            service: l.service,
            area: l.area,
            environment: l.environment,
            tags: l.tags,
            source: l.source,
            createdAt: l.createdAt,
          }));
          break;
        }
        case 'log_search': {
          const searchLogs = await logsService.findByProject(requireString(a, 'projectId'), {
            search: requireString(a, 'query'),
            level: optionalString(a, 'level'),
            limit: optionalNumber(a, 'limit'),
          });
          result = searchLogs.map((l) => ({
            _id: l._id,
            level: l.level,
            message: snippet(l.message, 300),
            service: l.service,
            area: l.area,
            environment: l.environment,
            tags: l.tags,
            createdAt: l.createdAt,
          }));
          break;
        }
        case 'log_stats': {
          result = await logsService.stats(requireString(a, 'projectId'));
          break;
        }
        case 'chat_create': {
          const created = await chatService.createSession(
            {
              projectId: optionalString(a, 'projectId'),
              customerId: optionalString(a, 'customerId'),
            },
            requireUserId(),
            optionalString(a, 'title'),
          );
          result = { _id: created._id, title: created.title };
          break;
        }
        case 'chat_list': {
          const sessions = await chatService.listSessions(
            {
              projectId: optionalString(a, 'projectId'),
              customerId: optionalString(a, 'customerId'),
            },
            requireUserId(),
            {
              includeArchived: optionalBoolean(a, 'includeArchived'),
              limit: optionalNumber(a, 'limit'),
              offset: optionalNumber(a, 'offset'),
            },
          );
          result = sessions.map((s) => ({
            _id: s._id,
            title: s.title,
            messageCount: countArray(s.messages),
            archived: s.archived,
            updatedAt: s.updatedAt,
          }));
          break;
        }
        case 'chat_get': {
          const session = await chatService.findById(requireString(a, 'id'), requireUserId());
          result = {
            _id: session._id,
            projectId: session.projectId,
            title: session.title,
            archived: session.archived,
            messages: (session.messages || []).map((m) => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              contextUsed: m.contextUsed,
              toolCalls: m.toolCalls,
            })),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          };
          break;
        }
        case 'chat_delete': {
          await chatService.deleteSession(requireString(a, 'id'), requireUserId());
          result = { deleted: true };
          break;
        }
        case 'chat_send': {
          const sessionId = requireString(a, 'sessionId');
          const content = requireString(a, 'content');
          const userId = requireUserId();
          const session = await chatService.findById(sessionId, userId);
          // Chat-Sessions können kunden- statt projektbezogen sein, dann ist
          // projectId leer. Vorher stand hier ein `as any`, das den Fall
          // verdeckte — ein kundenbezogener Chat lief in einen TypeError.
          if (!session.projectId) {
            return errorResult(
              'chat_send über MCP braucht eine projektbezogene Chat-Session; diese Session hängt an einem Kunden.',
            );
          }
          const projectId = session.projectId.toString();
          const opts = await chatLlmService.getOptions();

          const built = await chatContextService.build(projectId, content, session.messages, {
            topK: opts.topK,
            historyLimit: opts.historyLimit,
            toolsEnabled: opts.toolsEnabled,
          });

          // Plain streaming, collect tokens. Tool-calling within MCP chat_send is
          // intentionally not supported in v1 — the LLM cannot dispatch tools
          // back through the MCP transport. If you need tool-calling, use the
          // web chat UI which has the full loop.
          let assistantContent = '';
          for await (const token of chatLlmService.streamChat(built.messages)) {
            assistantContent += token;
          }

          // Persist user + assistant atomically
          await chatService.appendMessages(sessionId, [
            { role: 'user', content },
            {
              role: 'assistant',
              content: assistantContent,
              contextUsed: built.contextRefs,
            },
          ], userId);

          result = {
            sessionId,
            assistantContent,
            contextRefs: built.contextRefs,
          };
          break;
        }
        case 'monitor_create': {
          const headers = optionalObjectArray<{ name: string; value?: string }>(a, 'headers');
          const secretHeaders = optionalObjectArray<{ name: string; secretId: string }>(
            a,
            'secretHeaders',
          );
          // Nicht-Zahlen fliegen weiterhin raus, jetzt aber über ein
          // Typprädikat statt über `as number[]` vor dem Filter.
          const expectedStatusRaw = a.expectedStatus;
          const expectedStatus = isUnknownArray(expectedStatusRaw)
            ? expectedStatusRaw.filter((entry): entry is number => typeof entry === 'number')
            : undefined;
          const check = await monitoringService.create({
            customerId: requireString(a, 'customerId'),
            projectId: optionalString(a, 'projectId'),
            customerProjectId: optionalString(a, 'customerProjectId'),
            environmentId: optionalString(a, 'environmentId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            method: optionalEnum(a, 'method', Object.values(HealthcheckMethod)),
            url: requireString(a, 'url'),
            headers: headers?.map((h) => ({ name: h.name, value: h.value ?? '' })),
            secretHeaders,
            body: optionalString(a, 'body'),
            contentType: optionalString(a, 'contentType'),
            intervalSeconds: optionalNumber(a, 'intervalSeconds'),
            timeoutMs: optionalNumber(a, 'timeoutMs'),
            expectedStatus,
            expectedContent: optionalString(a, 'expectedContent'),
            failureThreshold: optionalNumber(a, 'failureThreshold'),
            active: optionalBoolean(a, 'active'),
          });
          result = compactCreateResult(check, { name: check.name, customerId: check.customerId });
          break;
        }
        case 'monitor_list': {
          const checks = await monitoringService.findByCustomer(requireString(a, 'customerId'));
          result = compactList(checks, ['__v', 'headers', 'secretHeaders', 'body']);
          break;
        }
        case 'monitor_get':
          result = await monitoringService.findById(requireString(a, 'id'));
          break;
        case 'monitor_update': {
          const headers = optionalObjectArray<{ name: string; value?: string }>(a, 'headers');
          const secretHeaders = optionalObjectArray<{ name: string; secretId: string }>(
            a,
            'secretHeaders',
          );
          // Nicht-Zahlen fliegen weiterhin raus, jetzt aber über ein
          // Typprädikat statt über `as number[]` vor dem Filter.
          const expectedStatusRaw = a.expectedStatus;
          const expectedStatus = isUnknownArray(expectedStatusRaw)
            ? expectedStatusRaw.filter((entry): entry is number => typeof entry === 'number')
            : undefined;
          result = compactUpdateResult(await monitoringService.update(requireString(a, 'id'), {
            projectId: optionalString(a, 'projectId'),
            customerProjectId: optionalString(a, 'customerProjectId'),
            environmentId: optionalString(a, 'environmentId'),
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            method: optionalEnum(a, 'method', Object.values(HealthcheckMethod)),
            url: optionalString(a, 'url'),
            headers: headers?.map((h) => ({ name: h.name, value: h.value ?? '' })),
            secretHeaders,
            body: optionalString(a, 'body'),
            contentType: optionalString(a, 'contentType'),
            intervalSeconds: optionalNumber(a, 'intervalSeconds'),
            timeoutMs: optionalNumber(a, 'timeoutMs'),
            expectedStatus,
            expectedContent: optionalString(a, 'expectedContent'),
            failureThreshold: optionalNumber(a, 'failureThreshold'),
            active: optionalBoolean(a, 'active'),
          }));
          break;
        }
        case 'monitor_delete':
          await monitoringService.remove(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'monitor_run':
          result = await monitoringService.runOnce(requireString(a, 'id'));
          break;
        case 'monitor_history':
          result = await monitoringService.listHistory(
            requireString(a, 'id'),
            optionalNumber(a, 'limit'),
            optionalNumber(a, 'offset'),
          );
          break;
        case 'monitor_summary':
          result = await monitoringService.getCustomerSummary(requireString(a, 'customerId'));
          break;
        case 'request_collection_create': {
          const col = await httpRequestsService.createCollection({
            projectId: requireString(a, 'projectId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            order: optionalNumber(a, 'order'),
          });
          result = compactCreateResult(col, { name: col.name });
          break;
        }
        case 'request_collection_list':
          result = compactList(
            (await httpRequestsService.listCollections(requireString(a, 'projectId'))),
            ['__v'],
          );
          break;
        case 'request_collection_update':
          result = compactUpdateResult(await httpRequestsService.updateCollection(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            order: optionalNumber(a, 'order'),
          }));
          break;
        case 'request_collection_delete':
          await httpRequestsService.deleteCollection(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'request_create': {
          const req = await httpRequestsService.createRequest({
            collectionId: requireString(a, 'collectionId'),
            name: requireString(a, 'name'),
            description: optionalString(a, 'description'),
            method: optionalEnum(a, 'method', Object.values(HttpRequestMethod)),
            url: requireString(a, 'url'),
            queryParams: optionalObject(a, 'queryParams'),
            headers: optionalObject(a, 'headers'),
            auth: optionalObject(a, 'auth'),
            body: optionalObject<BodyDto>(a, 'body'),
            timeoutMs: optionalNumber(a, 'timeoutMs'),
            followRedirects: optionalBoolean(a, 'followRedirects'),
          });
          result = compactCreateResult(req, { name: req.name });
          break;
        }
        case 'request_list':
          result = compactList(
            (await httpRequestsService.listRequests({
              collectionId: optionalString(a, 'collectionId'),
              projectId: optionalString(a, 'projectId'),
            })),
            ['__v', 'headers', 'queryParams', 'body', 'auth'],
          );
          break;
        case 'request_get':
          result = await httpRequestsService.getRequest(requireString(a, 'id'));
          break;
        case 'request_update':
          result = compactUpdateResult(await httpRequestsService.updateRequest(requireString(a, 'id'), {
            name: optionalString(a, 'name'),
            description: optionalString(a, 'description'),
            method: optionalEnum(a, 'method', Object.values(HttpRequestMethod)),
            url: optionalString(a, 'url'),
            queryParams: optionalObject(a, 'queryParams'),
            headers: optionalObject(a, 'headers'),
            auth: optionalObject(a, 'auth'),
            body: optionalObject<BodyDto>(a, 'body'),
            timeoutMs: optionalNumber(a, 'timeoutMs'),
            followRedirects: optionalBoolean(a, 'followRedirects'),
          }));
          break;
        case 'request_delete':
          await httpRequestsService.deleteRequest(requireString(a, 'id'));
          result = { deleted: true, id: a.id };
          break;
        case 'request_send': {
          const r = await httpRequestsService.send(requireString(a, 'id'), {
            environmentId: optionalString(a, 'environmentId'),
          });
          result = {
            historyId: r.historyId,
            ok: r.ok,
            status: r.status,
            durationMs: r.durationMs,
            contentType: r.contentType,
            bodySize: r.bodySize,
            truncated: r.truncated,
            body: r.body.length > 4000 ? r.body.slice(0, 4000) + '…' : r.body,
            error: r.error,
            unresolvedVariables: r.unresolvedVariables,
          };
          break;
        }
        case 'request_history_list':
          result = compactList(
            (await httpRequestsService.listHistory(
              requireString(a, 'id'),
              optionalNumber(a, 'limit'),
              optionalNumber(a, 'offset'),
            )),
            ['__v'],
          );
          break;
        case 'request_history_get':
          result = await httpRequestsService.getHistoryEntry(requireString(a, 'id'));
          break;
        case 'request_import_curl': {
          const req = await httpRequestsService.importCurl(
            requireString(a, 'collectionId'),
            requireString(a, 'curl'),
            optionalString(a, 'name'),
          );
          result = compactCreateResult(req, { name: req.name });
          break;
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }

      // Send in-app notification for tool usage (fire-and-forget)
      // notify_user already creates its own notification in the switch case
      if (name !== 'notify_user' && name !== 'ask_user' && name !== 'todo_ask_question') {
        const toolPrefix = name.split('_')[0];
        const derivedUrl = deriveNotificationUrl(name, a, result);
        notificationsService.create(
          formatToolTitle(name, result),
          formatToolBody(name, a, result),
          derivedUrl,
          `mcp_${toolPrefix}`,
        ).catch(() => {});
      }

      return textResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`Error: ${message}`);
    }
  });
}

export function deriveNotificationUrl(toolName: string, args: Record<string, unknown>, result: unknown): string | undefined {
  const r = isPlainRecord(result) ? result : undefined;
  // Coerce via idToString: results may be raw Mongoose docs (todo_comment)
  // or compact results — _id/projectId can be ObjectId or string.
  const resultProjectId = idToString(r?.projectId) ?? idToString(args.projectId);
  const resultCustomerId = idToString(r?.customerId) ?? idToString(args.customerId);
  const resultId = idToString(r?._id);

  switch (toolName) {
    case 'todo_create':
    case 'todo_update':
    case 'todo_comment':
      if (resultId && resultProjectId) return `/projects/${resultProjectId}/todos/${resultId}`;
      if (resultId && resultCustomerId) return `/customers/${resultCustomerId}/todos/${resultId}`;
      break;
    case 'milestone_create':
    case 'milestone_update':
      if (resultId && resultProjectId) return `/projects/${resultProjectId}/milestones/${resultId}`;
      break;
    case 'project_create':
    case 'project_update':
      if (resultId) return `/projects/${resultId}`;
      break;
    case 'knowledge_save':
    case 'knowledge_update':
      if (resultProjectId) return `/projects/${resultProjectId}?tab=knowledge`;
      break;
    case 'changelog_add':
    case 'changelog_update':
      if (resultProjectId) return `/projects/${resultProjectId}?tab=changelog`;
      break;
    case 'research_save':
    case 'research_update':
      if (resultProjectId) return `/projects/${resultProjectId}?tab=research`;
      break;
    case 'session_save':
      if (resultProjectId) return `/projects/${resultProjectId}?tab=sessions`;
      break;
    case 'schema_create':
    case 'schema_update':
      if (resultProjectId) return `/projects/${resultProjectId}?tab=schemas`;
      break;
    case 'feature_create':
    case 'feature_update':
      if (resultProjectId) return `/projects/${resultProjectId}?tab=features`;
      break;
    case 'release_create':
    case 'release_update':
      if (resultProjectId) return `/projects/${resultProjectId}?tab=releases`;
      break;
    default:
      break;
  }

  return undefined;
}

// Human-readable verb for a tool name, used in the notification title.
function toolVerb(toolName: string): string {
  if (toolName.endsWith('_create') || toolName.endsWith('_add') || toolName.endsWith('_save')) {
    return 'angelegt';
  }
  if (toolName.endsWith('_update')) return 'aktualisiert';
  if (toolName.endsWith('_delete') || toolName.endsWith('_remove')) return 'gelöscht';
  if (toolName.endsWith('_comment')) return 'kommentiert';
  if (toolName.endsWith('_archive')) return 'archiviert';
  if (toolName.endsWith('_get') || toolName.endsWith('_list') || toolName.endsWith('_search')) return 'gelesen';
  return 'ausgeführt';
}

// Friendly entity label, e.g. 'todo_create' → 'Quest'.
function toolEntityLabel(toolName: string): string {
  const map: Record<string, string> = {
    todo: 'Quest', milestone: 'Meilenstein', project: 'Projekt', knowledge: 'Wissen',
    changelog: 'Chronik', research: 'Studie', manual: 'Handbuch', session: 'Session',
    schema: 'Schema', dependency: 'Abhängigkeit', environment: 'Umgebung', secret: 'Siegel',
    feature: 'Feature', soul: 'Seele', commit: 'Commit', snippet: 'Pergament',
    attachment: 'Anhang', release: 'Release', recurring: 'Rite', customer: 'Kunde',
    contact: 'Kontakt', workflow: 'Workflow', oracle: 'Orakel', notify: 'Hinweis',
  };
  const prefix = toolName.split('_')[0];
  return map[prefix] ?? prefix;
}

function formatToolTitle(toolName: string, result: unknown): string {
  const r = isPlainRecord(result) ? result : undefined;
  const verb = toolVerb(toolName);
  const entity = toolEntityLabel(toolName);
  const display = typeof r?.displayNumber === 'string' ? r.displayNumber : undefined;
  const ref = display ? ` ${display}` : '';
  return `${entity}${ref} ${verb}`;
}

// Pretty-print a value for the notification body. Strips Mongo ObjectIds
// (24-hex-char strings) and falls back to a short slug.
function isObjectIdLike(v: string): boolean {
  return /^[0-9a-f]{24}$/i.test(v);
}

function formatToolBody(toolName: string, args: Record<string, unknown>, result: unknown): string {
  const r = isPlainRecord(result) ? result : undefined;
  const pieces: string[] = [];

  // Prefer human-readable result fields.
  const title = typeof r?.title === 'string' ? r.title : undefined;
  const name = typeof r?.name === 'string' ? r.name : undefined;
  const topic = typeof r?.topic === 'string' ? r.topic : undefined;
  const summary = typeof r?.summary === 'string' ? r.summary : undefined;
  const displayNumber = typeof r?.displayNumber === 'string' ? r.displayNumber : undefined;
  const head = title ?? name ?? topic ?? summary;
  if (head) {
    pieces.push(displayNumber ? `${displayNumber}: ${head}` : head);
  }

  // Status / priority / category if the tool sets them.
  for (const key of ['status', 'priority', 'category', 'scope']) {
    const v = r?.[key];
    if (typeof v === 'string') pieces.push(`${key}: ${v}`);
  }

  // From args, surface fields that aren't IDs and aren't already covered.
  const skipKeys = new Set(['projectId', 'customerId', 'milestoneId', 'todoId', 'id', '_id']);
  for (const [key, value] of Object.entries(args)) {
    if (skipKeys.has(key)) continue;
    if (value === undefined || value === null) continue;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof value === 'string' && isObjectIdLike(value)) continue;
    if (key === 'title' && head === value) continue;
    if (key === 'topic' && head === value) continue;
    if (key === 'name' && head === value) continue;
    const cut = str.length > 80 ? str.slice(0, 80) + '…' : str;
    pieces.push(`${key}: ${cut}`);
    if (pieces.length >= 4) break;
  }

  return pieces.length > 0 ? pieces.join(' · ') : toolName;
}
