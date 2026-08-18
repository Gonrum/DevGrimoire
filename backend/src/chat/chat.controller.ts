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
import type { AuthRequest } from '../common/request-context';
import { errorMessage, isRecord, isUnknownArray } from '../common/narrow';
import { ChatService } from './chat.service';
import { ChatLlmService, LlmMessageWithTools, LlmImageInput } from './chat-llm.service';
import { ChatContextService, AttachmentForContext } from './chat-context.service';
import { ChatToolsService, ALL_TOOL_NAMES, TOOL_GROUPS, WRITE_TOOL_NAMES } from './chat-tools';
import { ChatContextRef } from './schemas/chat-session.schema';
import { ResumeChatToolDto } from './dto/resume-chat-tool.dto';
import { ChatActivityService } from './chat-activity.service';
import { AgentRolesService } from '../agent-roles/agent-roles.service';
import { ChatAttachmentRef, ChatResponseMetrics, ChatToolCallRecord } from './schemas/chat-session.schema';
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
}

interface ToolLoopResult {
  fullResponse: string;
  firstTokenMs: number | null;
  pendingDone: boolean;
  pendingDoneReason?: string;
  /** Gesetzt, wenn vor einem schreibenden Tool angehalten wurde. */
  paused?: { call: PendingToolCall; queue: PendingToolCall[]; iter: number };
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

  @Post('config/test')
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
    );
  }

  @Get('sessions')
  async listSessions(
    @Req() req: ChatRequest,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
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
    const activeWorkspace = projectId
      ? await this.resolveActiveWorkspace(dto.workspaceId, projectId)
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
        toolCalls: dto.toolCalls?.map((tc) => ({
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
    const toolRecords: ChatToolCallRecord[] | undefined = dto.toolCalls?.map((tc) => ({
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
    const activeWorkspace = projectId
      ? await this.resolveActiveWorkspace(dto.workspaceId, projectId)
      : null;
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
          effectiveAllowlist,
          conversation,
          persisted: persistedToolCalls,
          images: built.images,
          startIter: 0,
          maxIter: opts.toolsMaxIterations,
          onEndpointSelected,
          confirmWrites: true,
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
      throw new NotFoundException('No tool call is awaiting confirmation for this session');
    }
    const userId = req.user?.userId;
    if (pending.userId !== userId) {
      // Die Session gehört jemand anderem — nicht bestätigbar.
      throw new NotFoundException('No tool call is awaiting confirmation for this session');
    }
    if (dto.callId !== pending.call.id) {
      throw new BadRequestException(
        `Stale confirmation: expected call ${pending.call.id}, got ${dto.callId}`,
      );
    }
    this.pendingConfirmations.delete(id);

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
          effectiveAllowlist: pending.effectiveAllowlist,
          conversation: pending.conversation,
          persisted: pending.persisted,
        });
      } else {
        const rejection = 'Rejected by the user — not executed.';
        send({ type: 'tool_result', id: pending.call.id, success: false, summary: rejection });
        pending.conversation.push({
          role: 'tool',
          tool_call_id: pending.call.id,
          name: pending.call.name,
          content: JSON.stringify({ error: rejection }),
        });
        pending.persisted.push({
          id: pending.call.id,
          name: pending.call.name,
          arguments: pending.call.arguments,
          success: false,
          error: rejection,
        });
      }

      const loop = await this.runToolLoop({
        send,
        abort,
        projectId: pending.projectId,
        effectiveAllowlist: pending.effectiveAllowlist,
        conversation: pending.conversation,
        persisted: pending.persisted,
        // Bilder sind in der ersten Runde bereits gesehen worden.
        startIter: pending.iter,
        maxIter: pending.maxIter,
        onEndpointSelected,
        confirmWrites: true,
        initialQueue: pending.queue,
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
  }): Promise<ToolLoopResult> {
    const tools = this.tools.getToolsForLlm(p.effectiveAllowlist);
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
          p.send({ type: 'tool_confirm', id: tc.id, name: tc.name, arguments: tc.arguments });
          return {
            fullResponse,
            firstTokenMs,
            pendingDone: false,
            paused: { call: tc, queue: queue.slice(1), iter },
          };
        }

        queue = queue.slice(1);
        await this.executeToolCall(tc, p);
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
   * Führt einen einzelnen Tool-Aufruf aus und schreibt Ergebnis, Konversation
   * und Persistenz fort. Herausgezogen, weil der Resume denselben Schritt für
   * den bestätigten Aufruf braucht.
   */
  private async executeToolCall(
    tc: PendingToolCall,
    p: {
      send: (event: Record<string, unknown>) => void;
      projectId: string | null;
      effectiveAllowlist: string[];
      conversation: LlmMessageWithTools[];
      persisted: ChatToolCallRecord[];
    },
  ): Promise<void> {
    p.send({ type: 'tool_status', phase: 'tool_call', name: tc.name, state: 'running' });
    p.send({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });

    let parsedArgs: Record<string, unknown>;
    try {
      // Ein geparster Nicht-Objekt-Wert (Array, Skalar) lief vorher als
      // `Record<string, unknown>` in den Dispatcher; jetzt gilt er als
      // ungültige Argumentliste — dieselbe Antwort wie kaputtes JSON.
      const parsed: unknown = tc.arguments ? JSON.parse(tc.arguments) : {};
      if (!isRecord(parsed)) throw new Error('arguments must be a JSON object');
      parsedArgs = parsed;
    } catch (err: unknown) {
      const error = `Invalid JSON arguments: ${errorMessage(err)}`;
      p.send({ type: 'tool_result', id: tc.id, success: false, summary: error });
      p.conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: JSON.stringify({ error }),
      });
      p.persisted.push({ id: tc.id, name: tc.name, arguments: tc.arguments, success: false, error });
      return;
    }

    const result = await this.tools.execute(tc.name, parsedArgs, { projectId: p.projectId }, p.effectiveAllowlist);
    const resultJson = JSON.stringify(result.success ? result.result : { error: result.error });
    const truncated = resultJson.length > MAX_TOOL_RESULT_CHARS
      ? resultJson.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated]'
      : resultJson;

    const summary = result.success
      ? this.summarizeResult(tc.name, result.result)
      : `error: ${result.error}`;
    p.send({ type: 'tool_result', id: tc.id, success: result.success, summary });
    p.send({ type: 'status', phase: 'responding' });

    p.conversation.push({
      role: 'tool',
      tool_call_id: tc.id,
      name: tc.name,
      content: truncated,
    });

    p.persisted.push({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      result: truncated,
      success: result.success,
      error: result.error,
    });
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
