import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { RequestContext, type AuthRequest } from '../common/request-context';
import { errorMessage, isRecord, isUnknownArray } from '../common/narrow';
import { assertContentWrite } from '../common/scope-guard';
import { ChatService } from './chat.service';
import { ChatLlmService, LlmMessageWithTools, LlmImageInput } from './chat-llm.service';
import { ChatContextService, AttachmentForContext } from './chat-context.service';
import { ChatToolsService, ALL_TOOL_NAMES, TOOL_GROUPS, WRITE_TOOL_NAMES } from './chat-tools';
import {
  allowSuggestions,
  isAllowedByList,
  isWorkspaceAgentTool,
  type WsPreview,
} from './workspace-agent-tools';
import { parseAgentAllowInput, type AgentAllowEntry, type AgentAllowInput } from '../workspaces/agent-allow';
import type { ToolContext } from './chat-tools';
import { ChatContextRef } from './schemas/chat-session.schema';
import { ResumeChatToolDto } from './dto/resume-chat-tool.dto';
import { ChatActivityService } from './chat-activity.service';
import { AgentRolesService } from '../agent-roles/agent-roles.service';
import { ChatAttachmentRef, ChatResponseMetrics, ChatToolCallRecord } from './schemas/chat-session.schema';
import { redactToolRecord } from './chat-redaction';
import { ChatActivityToolUse } from './schemas/chat-activity.schema';
import { AttachmentsService } from '../attachments/attachments.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { WorkspaceDocument } from '../workspaces/schemas/workspace.schema';
import { MinioService } from '../minio/minio.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';
import {
  CreateChatSessionDto,
  ExecuteChatToolDto,
  PersistChatMessageDto,
  PrepareChatMessageDto,
  SendChatMessageDto,
  TestChatEndpointDto,
  UpdateChatConfigDto,
  UpdateChatSessionDto,
} from './dto/chat.dto';

const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_ATTACHMENT_FILE_SIZE = parseInt(process.env.MINIO_MAX_FILE_SIZE || String(50 * 1024 * 1024), 10);

/**
 * Express-Request mit dem Actor, den `JwtAuthGuard` anhängt.
 *
 * `AuthRequest` ist die kanonische Fassung aus `common/request-context` — vorher
 * stand an zehn Stellen dieselbe Behauptung
 * `(req as Request & { user?: { userId: string } })`, die nebenbei `role` und
 * beide Scope-Achsen unterschlug.
 *
 * `req.user?.userId` bleibt bewusst optional: ist Authentifizierung komplett
 * deaktiviert, lässt der Guard ohne Actor durch, und die Handler unten geben
 * dann — wie bisher — `undefined` an die Service-Schicht weiter, wo `findById`
 * & Co. die Besitzprüfung überspringen. `listSessions`/`createSession` lehnen
 * fehlende Actor-Ids weiterhin explizit ab.
 */
type ChatRequest = Request & AuthRequest;

/**
 * Accepted MIME types for chat text attachments. Includes explicit entries
 * plus fallback via `text/*` and the file-extension sniffer below.
 */
const CHAT_TEXT_MIME_WHITELIST = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/xml',
  'text/html',
  'text/css',
  'text/x-python',
  'text/x-sql',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/x-sh',
  'application/pdf',
]);

const CHAT_TEXT_EXT_WHITELIST = new Set([
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.sh', '.bash',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb',
  '.sql', '.graphql', '.svelte', '.vue', '.prisma', '.ini', '.cfg',
  '.html', '.css', '.pdf',
]);

const CHAT_IMAGE_MIME_WHITELIST = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function acceptsChatUpload(mimeType: string, fileName: string): boolean {
  if (CHAT_TEXT_MIME_WHITELIST.has(mimeType)) return true;
  if (CHAT_IMAGE_MIME_WHITELIST.has(mimeType)) return true;
  if (mimeType.startsWith('text/')) return true;
  const ext = fileName.lastIndexOf('.') >= 0 ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  return CHAT_TEXT_EXT_WHITELIST.has(ext);
}

/**
 * Normalize a tool-call `arguments` string before replaying it to the LLM.
 *
 * During streaming we accumulate the model's JSON output token-by-token — the
 * result may contain whitespace artefacts, truncations, or non-canonical
 * escaping. Our own dispatcher is permissive (try/catch JSON.parse), but some
 * providers (e.g. Ollama Cloud) re-validate the tool_call arguments strictly
 * when we feed the assistant turn back in the next iteration and reject with
 * `invalid tool call arguments`. Canonicalizing via parse+stringify fixes that.
 * Returns `"{}"` if the raw value is unparseable so we never crash replay.
 */
function canonicalizeJsonArgs(raw: string | undefined | null): string {
  if (!raw || !raw.trim()) return '{}';
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return '{}';
  }
}

/**
 * Die drei Tools, die der Briefing-Mode zusätzlich freischaltet (T-424).
 * Als Konstante, damit der Test sie nicht abschreiben muss.
 */
export const BRIEFING_EXTRA_TOOLS = [
  'milestone_create_with_todos',
  'milestone_import_apply',
  'milestone_import_preview',
] as const;

/**
 * Erweitert die Allowlist um die Briefing-Tools — per **Union**, nie als
 * Ersatz (T-424).
 *
 * Das ist die sicherheitsrelevante Eigenschaft: der Schalter darf zusätzliche
 * Tools freigeben, aber keine bestehende Grenze aufweichen. Wäre es eine
 * Zuweisung statt einer Vereinigung, würde ein eingeschalteter Briefing-Mode
 * jede Rollen- oder Admin-Beschränkung überschreiben — aus einem
 * Komfort-Schalter würde ein Generalschlüssel.
 *
 * Als eigene Funktion herausgezogen (T-416), damit genau das prüfbar ist.
 */
export function extendAllowlistForBriefing(allowlist: string[]): string[] {
  return [...allowlist, ...BRIEFING_EXTRA_TOOLS.filter((t) => !allowlist.includes(t))];
}

/** Ein vom Modell angeforderter Tool-Aufruf, wie er über SSE hereinkommt. */
interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * The IDE agent's part of a turn: the session's workspace and the agent mode
 * read once at turn start (it holds until the turn ends, resumes included).
 */
interface AgentTurn {
  workspaceId: string;
  mode: 'confirm' | 'direct';
}

/** The actor ws_* calls run under (they fail closed without one). */
type ToolActor = Pick<AuthRequest, 'user' | 'apiKey'>;

/** Hash fixed by the preview; the confirmed write must still match it. */
type PinnedHash = { baseHash?: string | null };

/** Everything one tool call needs; shared by the loop and the resume. */
interface ToolCallParams {
  send: (event: Record<string, unknown>) => void;
  projectId: string | null;
  customerId?: string;
  effectiveAllowlist: string[];
  conversation: LlmMessageWithTools[];
  persisted: ChatToolCallRecord[];
  agent?: AgentTurn;
  actor?: ToolActor;
  /** Ends a running ws_exec when the turn is aborted. */
  signal?: AbortSignal;
}

type ConfirmDecision =
  | { kind: 'run' }
  | { kind: 'error'; error: string }
  | { kind: 'pause'; preview?: WsPreview; pinned?: PinnedHash; allowSuggestions?: AgentAllowInput[] };

const PROPOSAL_EXPIRED = { error: 'proposal_expired', message: 'Vorschlag verfallen — bitte erneut anfragen' };

/** Persisted history keeps at most this much of a ws_write/ws_edit text argument. */
const PERSISTED_AGENT_TEXT_BYTES = 4 * 1024;
const AGENT_TEXT_ARGS: Readonly<Record<string, readonly string[]>> = {
  ws_write: ['content'],
  ws_edit: ['oldText', 'newText'],
};

/** Cuts to `maxBytes` of UTF-8 without splitting a character. */
function cutUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const head = buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
  return `${head}…[truncated ${buf.length - Buffer.byteLength(head, 'utf8')} bytes]`;
}

/**
 * The arguments as they are stored in the session: file contents of
 * ws_write/ws_edit cut to 4 KiB. The live conversation keeps them whole.
 */
function persistedArguments(name: string, raw: string): string {
  const fields = AGENT_TEXT_ARGS[name];
  if (!fields) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed)) return raw;
  const out: Record<string, unknown> = { ...parsed };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === 'string') out[field] = cutUtf8(v, PERSISTED_AGENT_TEXT_BYTES);
  }
  return JSON.stringify(out);
}

/** Parsed call arguments with the owner ids pinned from the session (never from the LLM). */
function callArguments(
  tc: PendingToolCall,
  owner: { projectId: string | null; customerId?: string },
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    // Ein geparster Nicht-Objekt-Wert (Array, Skalar) gilt als ungültige
    // Argumentliste — dieselbe Antwort wie kaputtes JSON.
    parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
    if (!isRecord(parsed)) throw new Error('arguments must be a JSON object');
  } catch (err: unknown) {
    return { ok: false, error: `Invalid JSON arguments: ${errorMessage(err)}` };
  }
  return {
    ok: true,
    args: {
      ...parsed,
      ...(owner.projectId ? { projectId: owner.projectId } : {}),
      ...(owner.customerId ? { customerId: owner.customerId } : {}),
    },
  };
}

/**
 * Ein Turn, der auf eine Bestätigung wartet (T-415).
 *
 * Bewusst im Speicher und nicht in der Session: der Zustand lebt Sekunden bis
 * Minuten, und ein halb ausgeführter Turn hat in der persistierten Historie
 * nichts verloren. Ein Neustart des Backends verwirft ihn — der Client bekommt
 * dann 404 auf `resume` und der Nutzer fragt neu. Das ist der ehrlichere
 * Ausgang als ein Turn, der Tage später weiterläuft.
 */
interface PendingConfirmation {
  userId?: string;
  projectId: string | null;
  customerId?: string;
  effectiveAllowlist: string[];
  conversation: LlmMessageWithTools[];
  persisted: ChatToolCallRecord[];
  contextRefs: ChatContextRef[];
  call: PendingToolCall;
  queue: PendingToolCall[];
  iter: number;
  maxIter: number;
  fullResponse: string;
  firstTokenMs: number | null;
  userMessageLength: number;
  createdAtMs: number;
  /** IDE agent turns only. */
  agent?: AgentTurn;
  /** Hash from the preview of the paused ws_write/ws_edit. */
  pinned?: PinnedHash;
}

interface ToolLoopResult {
  fullResponse: string;
  firstTokenMs: number | null;
  pendingDone: boolean;
  pendingDoneReason?: string;
  /** Gesetzt, wenn vor einem schreibenden Tool angehalten wurde. */
  paused?: { call: PendingToolCall; queue: PendingToolCall[]; iter: number; pinned?: PinnedHash };
}

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  /**
   * Turns, die auf eine Bestätigung warten, je Session (T-415).
   *
   * Eine Session kann höchstens einen offenen Turn haben — ein zweiter
   * `sendMessage` verwirft den alten, weil der Nutzer dann offensichtlich
   * weitergezogen ist. Ohne diese Verdrängung sammelten sich Einträge, die
   * niemand mehr bestätigt.
   */
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();

  /** Nach dieser Zeit gilt eine unbeantwortete Bestätigung als verfallen. */
  private static readonly CONFIRM_TTL_MS = 30 * 60 * 1000;

  /**
   * Räumt verfallene Bestätigungen ab.
   *
   * Läuft bei jedem Zugriff statt per Timer: der Speicher ist klein, und ein
   * Intervall in einem Controller wäre eine Hintergrundaufgabe, die niemand
   * beendet.
   */
  private sweepPendingConfirmations(): void {
    const cutoff = Date.now() - ChatController.CONFIRM_TTL_MS;
    for (const [key, pending] of this.pendingConfirmations) {
      if (pending.createdAtMs < cutoff) this.pendingConfirmations.delete(key);
    }
  }

  constructor(
    private readonly chatService: ChatService,
    private readonly llm: ChatLlmService,
    private readonly context: ChatContextService,
    private readonly tools: ChatToolsService,
    private readonly attachments: AttachmentsService,
    private readonly minio: MinioService,
    private readonly workspaces: WorkspacesService,
    private readonly activity: ChatActivityService,
    private readonly agentRoles: AgentRolesService,
  ) {}

  /**
   * Estimate output token count from raw text. Most providers don't expose
   * usage in their streaming protocol, so we use a chars/4 heuristic that
   * roughly matches BPE behaviour for English/code. Marked as `estimated:true`
   * so the UI can render an "≈" badge instead of a hard number.
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.round(text.length / 4));
  }

  /** Build a metrics record from raw timing/token data. Returns undefined when no response was generated. */
  private buildMetrics(args: {
    fullResponse: string;
    startMs: number;
    firstTokenMs: number | null;
    endMs: number;
    totalDurationMs?: number;
  }): ChatResponseMetrics | undefined {
    if (!args.fullResponse.trim()) return undefined;
    const outputTokens = this.estimateTokens(args.fullResponse);
    const durationMs = Math.max(1, args.endMs - args.startMs);
    const firstTokenMs = args.firstTokenMs != null ? args.firstTokenMs - args.startMs : undefined;
    const generationMs = firstTokenMs != null
      ? Math.max(1, durationMs - firstTokenMs)
      : durationMs;
    const tokensPerSecond = Math.round((outputTokens / generationMs) * 1000 * 10) / 10;
    return {
      outputTokens,
      durationMs,
      firstTokenMs,
      tokensPerSecond,
      totalDurationMs: args.totalDurationMs,
      estimated: true,
    };
  }

  /** Aggregate streaming tool calls into per-tool {count, errors} buckets for activity logging. */
  private aggregateTools(records: ChatToolCallRecord[]): ChatActivityToolUse[] {
    const map = new Map<string, ChatActivityToolUse>();
    for (const r of records) {
      const cur = map.get(r.name) ?? { name: r.name, count: 0, errors: 0 };
      cur.count++;
      if (!r.success) cur.errors++;
      map.set(r.name, cur);
    }
    return Array.from(map.values());
  }

  /**
   * Resolves a workspaceId from the message DTO, returning the workspace
   * doc only if it exists AND belongs to this project. Anything else
   * (missing id, wrong project, deleted) silently degrades to null so a
   * stale frontend selection never blocks a chat turn.
   */
  private async resolveActiveWorkspace(
    workspaceId: string | undefined,
    projectId: string,
  ): Promise<WorkspaceDocument | null> {
    if (!workspaceId) return null;
    try {
      const ws = await this.workspaces.findById(workspaceId);
      if (ws.projectId.toString() !== projectId) return null;
      return ws;
    } catch {
      return null;
    }
  }

  /** The session's own workspace for IDE agent sessions; otherwise none. */
  private static agentWorkspaceId(session: { ideAgent?: boolean; workspaceId?: { toString(): string } }, projectId?: string): string | undefined {
    return projectId && session.ideAgent === true && session.workspaceId ? session.workspaceId.toString() : undefined;
  }

  /**
   * Runs `fn` under the request's actor. The SSE handlers stream long after
   * the guard ran; ws_* fail closed without an actor in `RequestContext`, so
   * the actor is set explicitly instead of relying on the interceptor's store.
   */
  private withActor<T>(actor: ToolActor | undefined, fn: () => T): T {
    return actor ? RequestContext.run(actor.user, actor.apiKey, fn) : fn();
  }

  /** The workspace's allow list as stored now (re-read for every call). */
  private async currentAgentAllow(workspaceId: string, actor: ToolActor | undefined): Promise<AgentAllowEntry[]> {
    try {
      const ws = await this.withActor(actor, () => this.workspaces.findById(workspaceId));
      return ws.agentAllow ?? [];
    } catch {
      // Unreachable workspace: nothing is allowed; the preview reports the error.
      return [];
    }
  }

  /**
   * Resolve attachment IDs to their extracted text (for text files) or base64 data
   * (for images) so the context builder / LLM adapters can consume them.
   * Cross-project access is rejected defensively even if AttachmentsService itself
   * doesn't enforce it.
   */
  private async loadAttachmentsForContext(
    projectId: string,
    attachmentIds: string[] | undefined,
  ): Promise<{
    forContext: AttachmentForContext[];
    images: LlmImageInput[];
    refs: ChatAttachmentRef[];
  }> {
    const forContext: AttachmentForContext[] = [];
    const images: LlmImageInput[] = [];
    const refs: ChatAttachmentRef[] = [];
    if (!attachmentIds || attachmentIds.length === 0) return { forContext, images, refs };

    for (const id of attachmentIds) {
      let attachment;
      let text: string | null;
      try {
        const res = await this.attachments.getText(id);
        attachment = res.attachment;
        text = res.text;
      } catch {
        throw new BadRequestException(`Attachment ${id} not found`);
      }
      if (!attachment.projectId) {
        throw new BadRequestException(
          `Attachment ${id} is customer-scoped and cannot be used in a project chat session`,
        );
      }
      if (attachment.projectId.toString() !== projectId) {
        throw new BadRequestException(
          `Attachment ${id} belongs to a different project than this chat session`,
        );
      }
      const kind: 'text' | 'image' = attachment.mimeType.startsWith('image/') ? 'image' : 'text';

      if (kind === 'image') {
        try {
          const { buffer } = await this.attachments.getContent(id);
          images.push({ data: buffer.toString('base64'), mediaType: attachment.mimeType });
        } catch (err: unknown) {
          this.logger.warn(`Failed to load image ${id} from storage: ${errorMessage(err)}`);
        }
      } else if (text) {
        // Text attachments with no extracted content (still processing or unsupported format)
        // are recorded for persistence but skipped for context injection.
        forContext.push({
          fileName: attachment.originalName,
          content: text,
          attachmentId: id,
          size: attachment.size,
        });
      }

      refs.push({
        attachmentId: id,
        fileName: attachment.originalName,
        size: attachment.size,
        extractedLength: text ? text.length : undefined,
        kind,
      });
    }

    return { forContext, images, refs };
  }

  // ---------- Configuration ----------

  @Get('config')
  async getConfig() {
    const endpoints = await this.llm.getEndpointsPublic();
    const opts = await this.llm.getOptions();
    return {
      enabled: opts.enabled,
      endpoints,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      topK: opts.topK,
      historyLimit: opts.historyLimit,
      toolsEnabled: opts.toolsEnabled,
      toolsAllowlist: opts.toolsAllowlist,
      toolsMaxIterations: opts.toolsMaxIterations,
      availableTools: ALL_TOOL_NAMES,
      toolGroups: TOOL_GROUPS,
      writeTools: Array.from(WRITE_TOOL_NAMES),
    };
  }

  @Put('config')
  @Roles(UserRole.ADMIN)
  async setConfig(@Body() dto: UpdateChatConfigDto) {
    await this.llm.setEndpoints(dto.endpoints);
    await this.llm.setOptions({
      enabled: dto.enabled,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
      topK: dto.topK,
      historyLimit: dto.historyLimit,
      toolsEnabled: dto.toolsEnabled,
      toolsAllowlist: dto.toolsAllowlist,
      toolsMaxIterations: dto.toolsMaxIterations,
    });
    return this.getConfig();
  }

  /** Throws 503 if the chat feature is globally disabled by an admin. */
  private async assertEnabled(): Promise<void> {
    if (!(await this.llm.isEnabled())) {
      throw new ServiceUnavailableException('Chat feature is disabled by an administrator');
    }
  }

  /**
   * Admin-only, wie `PUT config` daneben.
   *
   * War ungegated: ein Outbound-Fetch an eine URL aus dem Request-Body
   * (`fetch(`${endpoint.url}/v1/models`)` bzw. `/v1/messages`), wobei
   * `TestChatEndpointDto extends ChatEndpointDto {}` die `url` nur mit
   * `@IsString()` prüft — kein Schema, kein Host. Ein Nicht-Admin konnte damit
   * interne Ziele vom Backend-Container aus anfragen. Schwächer als die
   * RAG-Variante, weil hier kein Response-Body zurückgegeben wird (nur
   * `HTTP <status>` plus 140 Zeichen), aber Status und Antwortzeit reichen für
   * Port-Scanning und Dienst-Erkennung im Docker-Netz.
   *
   * Bewusst KEINE Private-IP-Blockade: Chat-Endpoints liegen laut
   * `.env.example` regulär auf `http://host.docker.internal:11434`,
   * `http://gpu:1234` oder `http://localhost:11434` — alles privat. Eine
   * Sperre würde die dokumentierte Default-Konfiguration abschalten.
   */
  @Post('config/test')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  async testConfig(@Body() dto: TestChatEndpointDto) {
    await this.assertEnabled();
    return this.llm.testEndpoint(dto);
  }

  // ---------- Session CRUD ----------

  @Post('sessions')
  @HttpCode(201)
  async createSession(@Body() dto: CreateChatSessionDto, @Req() req: ChatRequest) {
    await this.assertEnabled();
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException('Authentication required');
    return this.chatService.createSession(
      { projectId: dto.projectId, customerId: dto.customerId },
      userId,
      dto.title,
      { workspaceId: dto.workspaceId, ideAgent: dto.ideAgent },
    );
  }

  @Get('sessions')
  async listSessions(
    @Req() req: ChatRequest,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.assertEnabled();
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId query parameter is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    const userId = req.user?.userId;
    if (!userId) throw new BadRequestException('Authentication required');
    return this.chatService.listSessions({ projectId, customerId }, userId, {
      workspaceId: workspaceId || undefined,
      includeArchived: includeArchived === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string, @Req() req: ChatRequest) {
    await this.assertEnabled();
    const userId = req.user?.userId;
    return this.chatService.findById(id, userId);
  }

  @Put('sessions/:id')
  async updateSession(
    @Param('id') id: string,
    @Body() dto: UpdateChatSessionDto,
    @Req() req: ChatRequest,
  ) {
    await this.assertEnabled();
    if (!dto.title || !dto.title.trim()) {
      throw new BadRequestException('title is required');
    }
    const userId = req.user?.userId;
    return this.chatService.updateTitle(id, dto.title, userId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async deleteSession(@Param('id') id: string, @Req() req: ChatRequest): Promise<void> {
    await this.assertEnabled();
    const userId = req.user?.userId;
    await this.chatService.deleteSession(id, userId);
  }

  // ---------- Attachments ----------

  /**
   * Upload a text file / PDF attachment for the current session. The file is
   * persisted through AttachmentsService (MinIO), text is extracted async,
   * and when the user sends a message with this attachment's ID in
   * `attachmentIds`, the extracted text is injected into the prompt.
   */
  @Post('sessions/:id/attachments')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ATTACHMENT_FILE_SIZE },
    }),
  )
  async uploadAttachment(
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string } | undefined,
    @Req() req: ChatRequest,
  ) {
    await this.assertEnabled();
    if (!this.minio.isEnabled()) {
      throw new ServiceUnavailableException('File storage not configured');
    }
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    if (!acceptsChatUpload(file.mimetype, file.originalname)) {
      throw new UnsupportedMediaTypeException(
        `Unsupported file type: ${file.mimetype} (${file.originalname})`,
      );
    }

    const userId = req.user?.userId;
    const session = await this.chatService.findById(id, userId);
    if (!session.projectId) {
      throw new BadRequestException('Attachments are not supported in customer-scoped chat sessions');
    }
    const projectId = session.projectId.toString();

    const created = await this.attachments.create(
      {
        projectId,
        entityType: 'chat-message',
        entityId: id,
        tags: ['chat-attachment'],
      },
      file,
    );

    return {
      id: created._id.toString(),
      fileName: created.originalName,
      mimeType: created.mimeType,
      size: created.size,
      // Text extraction runs async in AttachmentsService — poll via GET if you
      // care about extractedLength, but for practical chat UX the user sends
      // right after so the text may arrive seconds later. ChatContextService
      // silently skips attachments without extracted text.
    };
  }

  // ---------- Browser-proxied LLM (prepare / persist / tools) ----------

  /**
   * Build the LLM-ready prompt + context for a session WITHOUT calling the LLM
   * or persisting any messages. Used by browser-mode chat where the user's own
   * browser does the inference call against their local LLM.
   */
  @Post('sessions/:id/prepare')
  @HttpCode(200)
  async prepareMessage(
    @Param('id') id: string,
    @Body() dto: PrepareChatMessageDto,
    @Req() req: ChatRequest,
  ) {
    await this.assertEnabled();
    if (!dto?.content?.trim()) {
      throw new BadRequestException('content is required');
    }
    const userId = req.user?.userId;
    const session = await this.chatService.findById(id, userId);
    const projectId = session.projectId?.toString();
    const customerId = session.customerId?.toString();
    const opts = await this.llm.getOptions();
    const { forContext, images, refs } = projectId
      ? await this.loadAttachmentsForContext(projectId, dto.attachmentIds)
      : { forContext: [], images: [] as LlmImageInput[], refs: [] as ChatAttachmentRef[] };
    if (!projectId && dto.attachmentIds && dto.attachmentIds.length > 0) {
      throw new BadRequestException('Attachments are not supported in customer-scoped chat sessions');
    }
    const boundWorkspaceId = ChatController.agentWorkspaceId(session, projectId);
    const activeWorkspace = projectId
      ? await this.resolveActiveWorkspace(boundWorkspaceId ?? dto.workspaceId, projectId)
      : null;
    const built = await this.context.build({ projectId, customerId }, dto.content, session.messages, {
      topK: opts.topK,
      historyLimit: opts.historyLimit,
      toolsEnabled: opts.toolsEnabled,
      attachments: forContext,
      images,
      activeWorkspace,
    });
    const useTools = opts.toolsEnabled && opts.toolsAllowlist.length > 0;
    return {
      projectId,
      customerId,
      systemPrompt: built.systemPrompt,
      messages: built.messages,
      contextRefs: built.contextRefs,
      attachmentRefs: refs,
      attachmentStats: built.attachmentStats,
      tools: useTools ? this.tools.getToolsForLlm(opts.toolsAllowlist) : undefined,
      toolsEnabled: useTools,
      toolsAllowlist: opts.toolsAllowlist,
      toolsMaxIterations: opts.toolsMaxIterations,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    };
  }

  /**
   * Atomically persist a user message and (optionally) the assistant response
   * produced by a browser-side LLM call.
   */
  @Post('sessions/:id/persist')
  @HttpCode(200)
  async persistMessage(
    @Param('id') id: string,
    @Body() dto: PersistChatMessageDto,
    @Req() req: ChatRequest,
  ) {
    await this.assertEnabled();
    if (!dto?.userContent?.trim()) {
      throw new BadRequestException('userContent is required');
    }
    const userId = req.user?.userId;

    // Resolve attachment refs for the user message (browser-mode parity with sendMessage).
    let userAttachmentRefs: ChatAttachmentRef[] | undefined;
    if (dto.attachmentIds && dto.attachmentIds.length > 0) {
      const session = await this.chatService.findById(id, userId);
      const projectId = session.projectId?.toString();
      if (!projectId) {
        throw new BadRequestException('Attachments are not supported in customer-scoped chat sessions');
      }
      const { refs } = await this.loadAttachmentsForContext(projectId, dto.attachmentIds);
      userAttachmentRefs = refs;
    }

    const inputs: Array<Parameters<ChatService['appendMessage']>[1]> = [
      { role: 'user', content: dto.userContent, attachments: userAttachmentRefs },
    ];
    if (dto.assistantContent && dto.assistantContent.trim()) {
      inputs.push({
        role: 'assistant',
        content: dto.assistantContent,
        contextUsed: dto.contextRefs,
        toolCalls: dto.toolCalls?.map((tc) => redactToolRecord({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          result: tc.result,
          success: tc.success,
          error: tc.error,
        })),
        metrics: dto.metrics
          ? {
              outputTokens: dto.metrics.outputTokens,
              durationMs: dto.metrics.durationMs,
              firstTokenMs: dto.metrics.firstTokenMs,
              tokensPerSecond: dto.metrics.tokensPerSecond,
              totalDurationMs: dto.metrics.totalDurationMs,
              estimated: dto.metrics.estimated,
            }
          : undefined,
      });
    }
    const result = await this.chatService.appendMessages(id, inputs, userId);

    // Browser-mode chat-activity log. Server mode logs in sendMessage.
    const toolRecords: ChatToolCallRecord[] | undefined = dto.toolCalls?.map((tc) => redactToolRecord({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      result: tc.result,
      success: tc.success,
      error: tc.error,
    }));
    const outcome = dto.browserAborted
      ? 'aborted'
      : dto.assistantContent && dto.assistantContent.trim()
        ? 'completed'
        : 'failed';
    await this.activity.record({
      sessionId: id,
      userId,
      projectId: result.projectId?.toString(),
      customerId: result.customerId?.toString(),
      mode: 'browser',
      endpointUrl: dto.browserEndpointUrl,
      model: dto.browserModel,
      toolsEnabled: !!toolRecords && toolRecords.length > 0,
      toolsUsed: toolRecords && toolRecords.length > 0 ? this.aggregateTools(toolRecords) : undefined,
      outcome,
      outputTokens: dto.metrics?.outputTokens,
      durationMs: dto.metrics?.durationMs,
      firstTokenMs: dto.metrics?.firstTokenMs,
      tokensPerSecond: dto.metrics?.tokensPerSecond,
      estimated: dto.metrics?.estimated,
      userMessageLength: dto.userContent.length,
    });

    return result;
  }

  /**
   * Execute a single tool call requested by the browser-side LLM.
   * Tool name must be in the global allowlist; result is truncated to
   * MAX_TOOL_RESULT_CHARS so the browser can append it to its message history.
   */
  @Post('sessions/:id/tools/execute')
  @HttpCode(200)
  async executeTool(
    @Param('id') id: string,
    @Body() dto: ExecuteChatToolDto,
    @Req() req: ChatRequest,
  ) {
    await this.assertEnabled();
    if (!dto?.name) {
      throw new BadRequestException('name is required');
    }
    // The IDE agent's workspace tools never run for a browser-side LLM,
    // whatever the allowlist says (spec "Festlegungen" 2).
    if (isWorkspaceAgentTool(dto.name)) {
      const error = 'ws_* tools cannot run through the browser path';
      return { success: false, error, result: undefined, content: JSON.stringify({ error }), summary: `error: ${error}` };
    }
    const userId = req.user?.userId;
    const session = await this.chatService.findById(id, userId);
    // T-56: owner-Id IMMER aus Session, nie aus DTO/args — verhindert
    // dass ein User über seine eigene Session Tools gegen fremde Projekte/Kunden
    // dispatcht. Die DTO-Felder werden ignoriert.
    const projectId = session.projectId?.toString();
    const customerId = session.customerId?.toString();
    if (!projectId && !customerId) {
      throw new BadRequestException('Chat session has neither projectId nor customerId');
    }
    const opts = await this.llm.getOptions();
    const rawArgs = (dto.arguments && typeof dto.arguments === 'object') ? dto.arguments : {};
    // Auch args.{projectId,customerId} überschreiben — der Browser-LLM darf nicht
    // manipulierte IDs einschmuggeln.
    const args = { ...rawArgs, ...(projectId ? { projectId } : {}), ...(customerId ? { customerId } : {}) };
    const result = await this.tools.execute(dto.name, args, { projectId: projectId || '' }, opts.toolsAllowlist);
    const resultJson = JSON.stringify(result.success ? result.result : { error: result.error });
    const truncated = resultJson.length > MAX_TOOL_RESULT_CHARS
      ? resultJson.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated]'
      : resultJson;
    const summary = result.success
      ? this.summarizeResult(dto.name, result.result)
      : `error: ${result.error}`;
    return {
      success: result.success,
      error: result.error,
      result: result.result,
      content: truncated,
      summary,
    };
  }

  // ---------- Message streaming ----------

  @Post('sessions/:id/message')
  async sendMessage(
    @Param('id') id: string,
    @Body() dto: SendChatMessageDto,
    @Req() req: ChatRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertEnabled();
    if (!dto?.content?.trim()) {
      throw new BadRequestException('content is required');
    }

    const userId = req.user?.userId;
    const session = await this.chatService.findById(id, userId);
    const projectId = session.projectId?.toString();
    const customerId = session.customerId?.toString();
    if (!projectId && !customerId) {
      throw new BadRequestException('Chat session has neither projectId nor customerId');
    }

    if (dto.attachmentIds && dto.attachmentIds.length > 0 && !projectId) {
      throw new BadRequestException('Attachments are not supported in customer-scoped chat sessions');
    }

    const { forContext: attachmentsForContext, images: attachmentImages, refs: attachmentRefs } = projectId
      ? await this.loadAttachmentsForContext(projectId, dto.attachmentIds)
      : { forContext: [], images: [] as LlmImageInput[], refs: [] as ChatAttachmentRef[] };

    await this.chatService.appendMessage(id, {
      role: 'user',
      content: dto.content,
      attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
    }, userId);

    const afterUser = await this.chatService.findById(id, userId);
    const historyWithoutCurrent = afterUser.messages.slice(0, -1);
    const opts = await this.llm.getOptions();
    const actor: ToolActor = { user: req.user, apiKey: req.apiKey };
    // IDE agent sessions: the workspace comes from the session, never from the message.
    const agentWorkspaceId = ChatController.agentWorkspaceId(session, projectId);
    let activeWorkspace: WorkspaceDocument | null = null;
    if (projectId && agentWorkspaceId) {
      activeWorkspace = await this.withActor(actor, () => this.resolveActiveWorkspace(agentWorkspaceId, projectId));
    } else if (projectId) {
      activeWorkspace = await this.resolveActiveWorkspace(dto.workspaceId, projectId);
    }
    // Read once per turn; an unreadable workspace falls back to asking.
    const agent: AgentTurn | undefined = agentWorkspaceId
      ? { workspaceId: agentWorkspaceId, mode: activeWorkspace?.agentMode === 'direct' ? 'direct' : 'confirm' }
      : undefined;
    const built = await this.context.build({ projectId, customerId }, dto.content, historyWithoutCurrent, {
      topK: opts.topK,
      historyLimit: opts.historyLimit,
      toolsEnabled: opts.toolsEnabled,
      attachments: attachmentsForContext,
      images: attachmentImages,
      activeWorkspace,
      agentRoleId: dto.agentRoleId,
      briefingMode: dto.briefingMode,
    });

    // Agent-Rollen schneiden die globale Tool-Allowlist (T-264) — eine Rolle
    // kann nichts freischalten, was der globale Setting nicht ohnehin erlaubt.
    let effectiveAllowlist = dto.agentRoleId
      ? this.agentRoles.intersectAllowedTools(dto.agentRoleId, opts.toolsAllowlist)
      : opts.toolsAllowlist;

    if (dto.briefingMode) {
      effectiveAllowlist = extendAllowlistForBriefing(effectiveAllowlist);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // `flushHeaders` gehört zu `http.ServerResponse` und ist damit deklariert;
    // die Prüfung bleibt für Response-Doubles ohne die Methode. Der direkte
    // Aufruf hält `this` gebunden — vorher war das ein `.call(res)` auf einer
    // losgelösten Methodenreferenz.
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on('close', onClose);

    send({ type: 'status', phase: 'context' });
    send({ type: 'context', refs: built.contextRefs });

    const useTools = opts.toolsEnabled && effectiveAllowlist.length > 0;
    let fullResponse = '';
    const persistedToolCalls: ChatToolCallRecord[] = [];
    let errored = false;
    // Umbenannt von `errorMessage`, damit der Helfer gleichen Namens hier
    // sichtbar bleibt statt vom lokalen Namen verdeckt zu werden.
    let streamError: string | undefined;
    let pendingDoneReason: string | undefined;
    let pendingDone = false;
    const requestStartMs = Date.now();
    let firstTokenMs: number | null = null;
    let selectedEndpoint: { provider: string; url: string; model: string } | undefined;
    const onEndpointSelected = (e: { provider: string; url: string; model: string }) => {
      selectedEndpoint = e;
    };

    try {
      if (!useTools) {
        send({ type: 'status', phase: 'thinking' });
        for await (const token of this.llm.streamChat(built.messages, {
          signal: abort.signal,
          images: built.images,
          onEndpointSelected,
        })) {
          if (abort.signal.aborted) break;
          if (firstTokenMs === null) firstTokenMs = Date.now();
          fullResponse += token;
          send({ type: 'token', content: token });
        }
        if (!abort.signal.aborted) pendingDone = true;
      } else {
        /*
         * Die Tool-Schleife steckt in `runToolLoop`, damit sie ein zweites Mal
         * betreten werden kann: nach einer Bestätigung setzt `resumeTool` genau
         * dort wieder auf (T-415). Der Rumpf ist unverändert übernommen.
         */
        const conversation: LlmMessageWithTools[] = built.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const loop = await this.runToolLoop({
          send,
          abort,
          projectId: projectId ?? null,
          customerId,
          effectiveAllowlist,
          conversation,
          persisted: persistedToolCalls,
          images: built.images,
          startIter: 0,
          maxIter: opts.toolsMaxIterations,
          onEndpointSelected,
          confirmWrites: true,
          agent,
          actor,
        });
        fullResponse += loop.fullResponse;
        if (loop.firstTokenMs !== null && firstTokenMs === null) firstTokenMs = loop.firstTokenMs;
        pendingDone = loop.pendingDone;
        pendingDoneReason = loop.pendingDoneReason;

        if (loop.paused) {
          /*
           * Angehalten vor einem schreibenden Tool. Der Turn ist NICHT fertig:
           * weder wird die Assistenten-Nachricht persistiert (sie wäre halb)
           * noch ein `done` gesendet. Beides holt der Resume nach, sobald der
           * Nutzer entschieden hat.
           */
          this.sweepPendingConfirmations();
          this.pendingConfirmations.set(id, {
            userId,
            projectId: projectId ?? null,
            customerId,
            effectiveAllowlist,
            conversation,
            persisted: persistedToolCalls,
            contextRefs: built.contextRefs,
            call: loop.paused.call,
            queue: loop.paused.queue,
            iter: loop.paused.iter,
            maxIter: opts.toolsMaxIterations,
            fullResponse,
            firstTokenMs,
            userMessageLength: dto.content.length,
            createdAtMs: Date.now(),
            agent,
            pinned: loop.paused.pinned,
          });
          clearInterval(heartbeat);
          req.off('close', onClose);
          if (!res.writableEnded) res.end();
          return;
        }
      }
    } catch (err: unknown) {
      errored = true;
      // Hier landen Timeouts und abgebrochene Streams — also genau die Fälle, in
      // denen ein Nicht-Error geworfen wird und `(err as Error).message` dem
      // Nutzer wie dem Chat-Log den Literalstring "undefined" zeigte.
      streamError = errorMessage(err) || 'LLM error';
      this.logger.warn(`Chat stream failed for session ${id}: ${streamError}`);
      send({ type: 'error', message: streamError });
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
    }

    const endMs = Date.now();
    const metrics = this.buildMetrics({
      fullResponse,
      startMs: requestStartMs,
      firstTokenMs,
      endMs,
      totalDurationMs: useTools && persistedToolCalls.length > 0 ? endMs - requestStartMs : undefined,
    });
    if (metrics && !abort.signal.aborted) {
      send({ type: 'metrics', ...metrics });
    }
    if (pendingDone && !abort.signal.aborted && !errored) {
      send({ type: 'done', ...(pendingDoneReason ? { reason: pendingDoneReason } : {}) });
    }

    if (!errored && fullResponse.trim()) {
      try {
        await this.chatService.appendMessage(id, {
          role: 'assistant',
          content: fullResponse,
          contextUsed: built.contextRefs,
          toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : undefined,
          metrics,
        }, userId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to persist assistant message for session ${id}: ${errorMessage(err)}`,
        );
      }
    }

    // Persist a chat-activity record for the Settings → Chat-Log view. Logs even
    // failed/aborted runs so admins can see flaky endpoints and tool errors.
    const outcome: 'completed' | 'aborted' | 'failed' | 'no_endpoint' = errored
      ? (selectedEndpoint ? 'failed' : 'no_endpoint')
      : abort.signal.aborted
        ? 'aborted'
        : 'completed';
    await this.activity.record({
      sessionId: id,
      userId,
      projectId,
      customerId,
      mode: 'server',
      provider: selectedEndpoint?.provider,
      endpointUrl: selectedEndpoint?.url,
      model: selectedEndpoint?.model,
      toolsEnabled: useTools,
      toolsUsed: persistedToolCalls.length > 0 ? this.aggregateTools(persistedToolCalls) : undefined,
      outcome,
      errorMessage: streamError,
      outputTokens: metrics?.outputTokens,
      durationMs: metrics?.durationMs,
      firstTokenMs: metrics?.firstTokenMs,
      tokensPerSecond: metrics?.tokensPerSecond,
      estimated: metrics?.estimated,
      hadImages: (built.images?.length ?? 0) > 0,
      userMessageLength: dto.content.length,
    });

    if (!res.writableEnded) res.end();
  }



  /**
   * Setzt einen Turn fort, der vor einem schreibenden Tool angehalten hat
   * (T-415).
   *
   * Der Client zeigt die Vorschau und ruft diesen Endpunkt mit `approved`.
   * Antwort ist wieder ein SSE-Stream — die Schleife läuft weiter, als hätte
   * sie nie gehalten.
   *
   * Bei `approved: false` wird der Aufruf **nicht** ausgeführt, aber als
   * `tool`-Ergebnis in die Konversation geschrieben. Das ist keine Kosmetik:
   * zu jedem `tool_call` gehört genau ein Ergebnis, sonst quittiert der
   * Provider den nächsten Durchlauf mit einem Fehler.
   */
  @Post('sessions/:id/tools/resume')
  async resumeTool(
    @Param('id') id: string,
    @Body() dto: ResumeChatToolDto,
    @Req() req: ChatRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertEnabled();
    this.sweepPendingConfirmations();

    const pending = this.pendingConfirmations.get(id);
    if (!pending) {
      // Kein offener Turn: Backend neu gestartet, TTL abgelaufen oder der
      // Client ist zweimal losgelaufen.
      throw new NotFoundException(PROPOSAL_EXPIRED);
    }
    const userId = req.user?.userId;
    if (pending.userId !== userId) {
      // Die Session gehört jemand anderem — nicht bestätigbar.
      throw new NotFoundException(PROPOSAL_EXPIRED);
    }
    if (dto.callId !== pending.call.id) {
      throw new BadRequestException(
        `Stale confirmation: expected call ${pending.call.id}, got ${dto.callId}`,
      );
    }
    // Validated before anything changes: a 400 leaves the proposal open.
    const alwaysAllow = dto.alwaysAllow !== undefined ? ChatController.checkAlwaysAllow(pending, dto) : undefined;
    this.pendingConfirmations.delete(id);
    // The actor of THIS request: rights and workspace state are checked anew.
    const actor: ToolActor = { user: req.user, apiKey: req.apiKey };
    if (alwaysAllow && pending.agent) {
      const workspaceId = pending.agent.workspaceId;
      try {
        // Same right and same service path as POST /workspaces/:id/agent-allow.
        await this.withActor(actor, async () => {
          assertContentWrite('Changing the agent allow list');
          await this.workspaces.addAgentAllow(workspaceId, alwaysAllow);
        });
      } catch (err: unknown) {
        // Nothing was executed: keep the proposal answerable.
        if (!this.pendingConfirmations.has(id)) this.pendingConfirmations.set(id, pending);
        throw err;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on('close', onClose);

    // Kein erneutes `getOptions()`: `maxIter` und die Allowlist kommen aus dem
    // gemerkten Zustand. Ändert ein Admin die Einstellungen zwischen Anhalten
    // und Bestätigen, läuft der Turn trotzdem unter den Regeln, unter denen er
    // begonnen hat — sonst könnte sich die Tool-Freigabe mitten im Turn ändern.
    let fullResponse = pending.fullResponse;
    let firstTokenMs = pending.firstTokenMs;
    let errored = false;
    let streamError: string | undefined;
    let pendingDone = false;
    let pendingDoneReason: string | undefined;
    let selectedEndpoint: { provider: string; url: string; model: string } | undefined;
    const onEndpointSelected = (e: { provider: string; url: string; model: string }) => {
      selectedEndpoint = e;
    };
    const requestStartMs = Date.now();

    try {
      if (dto.approved) {
        await this.executeToolCall(pending.call, {
          send,
          projectId: pending.projectId,
          customerId: pending.customerId,
          effectiveAllowlist: pending.effectiveAllowlist,
          conversation: pending.conversation,
          persisted: pending.persisted,
          agent: pending.agent,
          actor,
          signal: abort.signal,
        }, pending.pinned);
      } else {
        const rejection = 'Rejected by the user — not executed.';
        send({ type: 'tool_result', id: pending.call.id, success: false, summary: rejection });
        pending.conversation.push({
          role: 'tool',
          tool_call_id: pending.call.id,
          name: pending.call.name,
          content: JSON.stringify({ error: rejection }),
        });
        pending.persisted.push(redactToolRecord({
          id: pending.call.id,
          name: pending.call.name,
          arguments: persistedArguments(pending.call.name, pending.call.arguments),
          success: false,
          error: rejection,
        }));
      }

      const loop = await this.runToolLoop({
        send,
        abort,
        projectId: pending.projectId,
        customerId: pending.customerId,
        effectiveAllowlist: pending.effectiveAllowlist,
        conversation: pending.conversation,
        persisted: pending.persisted,
        // Bilder sind in der ersten Runde bereits gesehen worden.
        startIter: pending.iter,
        maxIter: pending.maxIter,
        onEndpointSelected,
        confirmWrites: true,
        initialQueue: pending.queue,
        agent: pending.agent,
        actor,
      });
      fullResponse += loop.fullResponse;
      if (loop.firstTokenMs !== null && firstTokenMs === null) firstTokenMs = loop.firstTokenMs;
      pendingDone = loop.pendingDone;
      pendingDoneReason = loop.pendingDoneReason;

      if (loop.paused) {
        // Noch ein schreibendes Tool im selben Turn — erneut anhalten.
        this.pendingConfirmations.set(id, {
          ...pending,
          call: loop.paused.call,
          queue: loop.paused.queue,
          iter: loop.paused.iter,
          pinned: loop.paused.pinned,
          fullResponse,
          firstTokenMs,
          createdAtMs: Date.now(),
        });
        clearInterval(heartbeat);
        req.off('close', onClose);
        if (!res.writableEnded) res.end();
        return;
      }
    } catch (err: unknown) {
      errored = true;
      streamError = errorMessage(err) || 'LLM error';
      this.logger.warn(`Chat resume failed for session ${id}: ${streamError}`);
      send({ type: 'error', message: streamError });
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
    }

    const endMs = Date.now();
    const metrics = this.buildMetrics({
      fullResponse,
      startMs: requestStartMs,
      firstTokenMs,
      endMs,
      totalDurationMs: endMs - requestStartMs,
    });
    if (metrics && !abort.signal.aborted) send({ type: 'metrics', ...metrics });
    if (pendingDone && !abort.signal.aborted && !errored) {
      send({ type: 'done', ...(pendingDoneReason ? { reason: pendingDoneReason } : {}) });
    }

    if (!errored && fullResponse.trim()) {
      try {
        await this.chatService.appendMessage(id, {
          role: 'assistant',
          content: fullResponse,
          contextUsed: pending.contextRefs,
          toolCalls: pending.persisted.length > 0 ? pending.persisted : undefined,
          metrics,
        }, userId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to persist assistant message for session ${id}: ${errorMessage(err)}`,
        );
      }
    }

    /*
     * Der Chat-Log-Eintrag entsteht erst hier, nicht schon beim Anhalten: erst
     * jetzt steht fest, was der Turn insgesamt getan hat. Wird nie bestätigt,
     * gibt es keinen Eintrag — der Turn hat dann auch nichts bewirkt.
     */
    await this.activity.record({
      sessionId: id,
      userId,
      projectId: pending.projectId ?? undefined,
      customerId: pending.customerId,
      mode: 'server',
      provider: selectedEndpoint?.provider,
      endpointUrl: selectedEndpoint?.url,
      model: selectedEndpoint?.model,
      toolsEnabled: true,
      toolsUsed: pending.persisted.length > 0 ? this.aggregateTools(pending.persisted) : undefined,
      outcome: errored ? (selectedEndpoint ? 'failed' : 'no_endpoint') : abort.signal.aborted ? 'aborted' : 'completed',
      errorMessage: streamError,
      outputTokens: metrics?.outputTokens,
      durationMs: metrics?.durationMs,
      firstTokenMs: metrics?.firstTokenMs,
      tokensPerSecond: metrics?.tokensPerSecond,
      estimated: metrics?.estimated,
      hadImages: false,
      userMessageLength: pending.userMessageLength,
    });

    if (!res.writableEnded) res.end();
  }

  /**
   * Die Tool-Schleife des Server-Modus (T-415).
   *
   * Als eigene Methode, damit sie **zweimal** betreten werden kann: einmal aus
   * `sendMessage`, und nach einer Bestätigung erneut aus `resumeTool`. Der
   * Rumpf ist der frühere Inline-Block, unverändert bis auf die Pause.
   *
   * `conversation` und `persisted` werden **in place** fortgeschrieben — der
   * Aufrufer hält dieselben Arrays und kann sie bei einer Pause wegspeichern,
   * ohne dass hier etwas kopiert werden müsste.
   */
  private async runToolLoop(p: {
    send: (event: Record<string, unknown>) => void;
    abort: AbortController;
    projectId: string | null;
    customerId?: string;
    effectiveAllowlist: string[];
    conversation: LlmMessageWithTools[];
    persisted: ChatToolCallRecord[];
    images?: LlmImageInput[];
    startIter: number;
    maxIter: number;
    onEndpointSelected: (e: { provider: string; url: string; model: string }) => void;
    /** Vor der Bestätigung anhalten, statt schreibende Tools auszuführen. */
    confirmWrites: boolean;
    /**
     * Aufgeschobene Aufrufe desselben Durchlaufs (Resume). Sie werden
     * abgearbeitet, bevor das Modell erneut befragt wird — sonst ginge die
     * Reihenfolge der Tool-Calls verloren.
     */
    initialQueue?: PendingToolCall[];
    /** IDE agent turn: ws_* offered and bound to its workspace. */
    agent?: AgentTurn;
    actor?: ToolActor;
  }): Promise<ToolLoopResult> {
    const tools = this.tools.getToolsForLlm(p.effectiveAllowlist, p.agent !== undefined);
    const callParams: ToolCallParams = { ...p, signal: p.abort.signal };
    const conversation = p.conversation;
    let fullResponse = '';
    let firstTokenMs: number | null = null;
    let pendingDone = false;
    let pendingDoneReason: string | undefined;
    // Only attach images to the first iteration — once the model has seen them
    // and replied / issued a tool-call, follow-up turns don't need them re-sent.
    let imagesForIteration: LlmImageInput[] | undefined = p.images;
    let queue: PendingToolCall[] = p.initialQueue ?? [];

    for (let iter = p.startIter; iter < p.maxIter; iter++) {
      if (p.abort.signal.aborted) break;

      if (queue.length === 0) {
        const pendingToolCalls: PendingToolCall[] = [];
        let iterFinishReason: 'stop' | 'tool_calls' | 'length' | 'other' = 'other';
        let iterContent = '';

        p.send({ type: 'status', phase: iter === 0 ? 'thinking' : 'responding' });
        for await (const event of this.llm.streamChatWithTools(conversation, tools, {
          signal: p.abort.signal,
          images: imagesForIteration,
          onEndpointSelected: p.onEndpointSelected,
        })) {
          if (p.abort.signal.aborted) break;
          if (event.type === 'content') {
            if (firstTokenMs === null) firstTokenMs = Date.now();
            iterContent += event.delta;
            fullResponse += event.delta;
            p.send({ type: 'token', content: event.delta });
          } else if (event.type === 'tool_call') {
            pendingToolCalls.push(event);
          } else if (event.type === 'finish') {
            iterFinishReason = event.reason;
          }
        }

        if (p.abort.signal.aborted) break;

        if (iterFinishReason !== 'tool_calls' || pendingToolCalls.length === 0) {
          pendingDone = true;
          break;
        }

        // Assistant turn with tool_calls (content may be empty, that's fine).
        // Canonicalize arguments so strict providers (Ollama Cloud) don't 400
        // on the next iteration due to streaming-accumulator artefacts.
        conversation.push({
          role: 'assistant',
          content: iterContent,
          tool_calls: pendingToolCalls.map((tc) => {
            const canonical = canonicalizeJsonArgs(tc.arguments);
            if (canonical === '{}' && tc.arguments && tc.arguments.trim() !== '{}') {
              this.logger.debug(
                `tool_call ${tc.name} raw arguments unparseable, falling back to "{}": ${tc.arguments.slice(0, 200)}`,
              );
            }
            return {
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: canonical },
            };
          }),
        });
        queue = pendingToolCalls;
      }

      while (queue.length > 0) {
        if (p.abort.signal.aborted) break;
        const tc = queue[0];

        /*
         * Vor einem schreibenden Tool anhalten. Der Stream endet hier; der
         * Client zeigt die Vorschau und ruft `tools/resume`. Die noch nicht
         * abgearbeiteten Aufrufe dieses Durchlaufs wandern mit in den
         * gemerkten Zustand — sonst ginge ihre Reihenfolge verloren.
         */
        if (p.confirmWrites && WRITE_TOOL_NAMES.has(tc.name)) {
          // ws_* decide per call (mode + allow list + preview); all others ask as before.
          const decision: ConfirmDecision = isWorkspaceAgentTool(tc.name)
            ? await this.agentConfirmDecision(tc, callParams)
            : { kind: 'pause' };
          if (decision.kind === 'pause') {
            p.send({
              type: 'tool_confirm',
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              ...(decision.preview ? { preview: decision.preview, allowSuggestions: decision.allowSuggestions ?? [] } : {}),
            });
            return {
              fullResponse,
              firstTokenMs,
              pendingDone: false,
              paused: { call: tc, queue: queue.slice(1), iter, ...(decision.pinned ? { pinned: decision.pinned } : {}) },
            };
          }
          if (decision.kind === 'error') {
            // Unworkable already in the preview: the LLM learns why, the user is not asked.
            queue = queue.slice(1);
            this.recordToolError(tc, decision.error, callParams);
            continue;
          }
        }

        queue = queue.slice(1);
        await this.executeToolCall(tc, callParams);
      }

      if (iter === p.maxIter - 1) {
        pendingDone = true;
        pendingDoneReason = 'max_iterations_reached';
      }
      // After the first iteration the model has seen the images — further
      // tool-call rounds don't need to resend them.
      imagesForIteration = undefined;
    }

    return { fullResponse, firstTokenMs, pendingDone, pendingDoneReason };
  }

  /**
   * Whether a writing ws_* call must be confirmed (spec "Festlegungen" 5/6):
   * not in mode `direct`, not when the stored allow list (read now) covers it.
   * Otherwise the server builds the preview; a preview error goes to the LLM
   * instead of the user. Errors the execution itself reports (not in the
   * allowlist, not an IDE session, bad JSON) run straight into `execute`.
   */
  private async agentConfirmDecision(tc: PendingToolCall, p: ToolCallParams): Promise<ConfirmDecision> {
    const agent = p.agent;
    if (!agent || !p.effectiveAllowlist.includes(tc.name)) return { kind: 'run' };
    if (agent.mode === 'direct') return { kind: 'run' };
    // The same parsed arguments `execute` gets: what was allowed is what runs.
    const parsed = callArguments(tc, p);
    if (!parsed.ok) return { kind: 'run' };
    const entries = await this.currentAgentAllow(agent.workspaceId, p.actor);
    if (isAllowedByList(tc.name, parsed.args, entries)) return { kind: 'run' };
    const preview = await this.withActor(p.actor, () =>
      this.tools.previewAgentTool(tc.name, parsed.args, { workspaceId: agent.workspaceId }, p.effectiveAllowlist));
    if (!preview.ok) return { kind: 'error', error: preview.error };
    return {
      kind: 'pause',
      preview: preview.preview,
      allowSuggestions: allowSuggestions(tc.name, parsed.args),
      ...(preview.preview.kind === 'file' ? { pinned: { baseHash: preview.preview.baseHash ?? null } } : {}),
    };
  }

  /**
   * Validates `alwaysAllow` of a resume (throws 400): only with an approval,
   * only for a writing ws_* call of an IDE turn, same rules as
   * `POST agent-allow`, and the entry must allow exactly the paused call — a
   * click must not unlock anything other than what the card showed.
   */
  private static checkAlwaysAllow(pending: PendingConfirmation, dto: ResumeChatToolDto): AgentAllowInput {
    if (!dto.approved) throw new BadRequestException('alwaysAllow requires approved: true');
    const name = pending.call.name;
    if (!pending.agent || !isWorkspaceAgentTool(name) || !WRITE_TOOL_NAMES.has(name)) {
      throw new BadRequestException('alwaysAllow is only available for writing workspace agent tools');
    }
    const input = parseAgentAllowInput(dto.alwaysAllow ?? {});
    const parsed = callArguments(pending.call, pending);
    const entry: AgentAllowEntry = { ...input, createdAt: new Date() };
    if (!parsed.ok || !isAllowedByList(name, parsed.args, [entry])) {
      throw new BadRequestException('alwaysAllow does not cover this call');
    }
    return input;
  }

  /** A call that ends before it runs: error to the client, the LLM and the history. */
  private recordToolError(tc: PendingToolCall, error: string, p: ToolCallParams): void {
    p.send({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });
    p.send({ type: 'tool_result', id: tc.id, success: false, summary: `error: ${error}` });
    p.conversation.push({
      role: 'tool',
      tool_call_id: tc.id,
      name: tc.name,
      content: JSON.stringify({ error }),
    });
    p.persisted.push(redactToolRecord({
      id: tc.id,
      name: tc.name,
      arguments: persistedArguments(tc.name, tc.arguments),
      success: false,
      error,
    }));
  }

  /**
   * Führt einen einzelnen Tool-Aufruf aus und schreibt Ergebnis, Konversation
   * und Persistenz fort. Herausgezogen, weil der Resume denselben Schritt für
   * den bestätigten Aufruf braucht. ws_* run under the actor, bound to the
   * turn's workspace; `pinned` is the hash of a confirmed preview.
   */
  private async executeToolCall(tc: PendingToolCall, p: ToolCallParams, pinned?: PinnedHash): Promise<void> {
    p.send({ type: 'tool_status', phase: 'tool_call', name: tc.name, state: 'running' });
    p.send({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });

    // Same pinning as the browser path (executeTool): the owner ids always come
    // from the session, never from LLM-generated arguments.
    const parsed = callArguments(tc, p);
    if (!parsed.ok) {
      const error = parsed.error;
      p.send({ type: 'tool_result', id: tc.id, success: false, summary: error });
      p.conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: JSON.stringify({ error }),
      });
      p.persisted.push(redactToolRecord({ id: tc.id, name: tc.name, arguments: tc.arguments, success: false, error }));
      return;
    }
    const args = parsed.args;

    const agentCall = p.agent !== undefined && isWorkspaceAgentTool(tc.name);
    const ctx: ToolContext = agentCall && p.agent
      ? { projectId: p.projectId, agentWorkspace: { workspaceId: p.agent.workspaceId, ...(p.signal ? { signal: p.signal } : {}) } }
      : { projectId: p.projectId };
    const result = agentCall
      ? await this.withActor(p.actor, () => this.tools.execute(tc.name, args, ctx, p.effectiveAllowlist, pinned))
      : await this.tools.execute(tc.name, args, ctx, p.effectiveAllowlist);
    const resultJson = JSON.stringify(result.success ? result.result : { error: result.error });
    const truncated = resultJson.length > MAX_TOOL_RESULT_CHARS
      ? resultJson.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated]'
      : resultJson;

    const summary = result.success
      ? this.summarizeResult(tc.name, result.result)
      : `error: ${result.error}`;
    p.send({ type: 'tool_result', id: tc.id, success: result.success, summary });
    // The IDE reloads tree, git status and clean tabs for these paths.
    if (result.success && result.changedPaths && result.changedPaths.length > 0) {
      p.send({ type: 'workspace_changed', paths: result.changedPaths });
    }
    p.send({ type: 'status', phase: 'responding' });

    p.conversation.push({
      role: 'tool',
      tool_call_id: tc.id,
      name: tc.name,
      content: truncated,
    });

    // M-9: gespeichert wird die geschwärzte Fassung; das LLM oben bekommt
    // weiter den Originalwert.
    p.persisted.push(redactToolRecord({
      id: tc.id,
      name: tc.name,
      arguments: persistedArguments(tc.name, tc.arguments),
      result: truncated,
      success: result.success,
      error: result.error,
    }));
  }

  /** Short human-readable summary of a tool result for SSE/UI display */
  private summarizeResult(toolName: string, result: unknown): string {
    if (result == null) return 'empty';
    if (isUnknownArray(result)) return `${result.length} items`;
    if (isRecord(result)) {
      if (isUnknownArray(result.items)) return `${result.items.length} items`;
      if (typeof result.count === 'number') return `${result.count} items`;
      const keys = Object.keys(result);
      return `${toolName}: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}`;
    }
    // Nur noch Skalare möglich. Ein `String(unknown)` hätte für die restlichen
    // Fälle (Funktion, Symbol) Quelltext bzw. Unsinn in die UI geschrieben —
    // ein Tool-Ergebnis kommt aus JSON und ist keins von beiden.
    if (typeof result === 'string') return result.slice(0, 80);
    if (typeof result === 'number' || typeof result === 'boolean' || typeof result === 'bigint') {
      return String(result).slice(0, 80);
    }
    return typeof result;
  }
}
