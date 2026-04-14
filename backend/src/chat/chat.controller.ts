import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
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
import { ChatService } from './chat.service';
import { ChatLlmService, LlmMessageWithTools, LlmImageInput } from './chat-llm.service';
import { ChatContextService, AttachmentForContext } from './chat-context.service';
import { ChatToolsService, ALL_TOOL_NAMES, TOOL_GROUPS, WRITE_TOOL_NAMES } from './chat-tools';
import { ChatAttachmentRef, ChatToolCallRecord } from './schemas/chat-session.schema';
import { AttachmentsService } from '../attachments/attachments.service';
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

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly llm: ChatLlmService,
    private readonly context: ChatContextService,
    private readonly tools: ChatToolsService,
    private readonly attachments: AttachmentsService,
    private readonly minio: MinioService,
  ) {}

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
        } catch (err) {
          this.logger.warn(`Failed to load image ${id} from storage: ${(err as Error).message}`);
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
  async createSession(@Body() dto: CreateChatSessionDto, @Req() req: Request) {
    await this.assertEnabled();
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    if (!userId) throw new BadRequestException('Authentication required');
    return this.chatService.createSession(dto.projectId, userId, dto.title);
  }

  @Get('sessions')
  async listSessions(
    @Req() req: Request,
    @Query('projectId') projectId?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.assertEnabled();
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    if (!userId) throw new BadRequestException('Authentication required');
    return this.chatService.listSessions(projectId, userId, {
      includeArchived: includeArchived === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string, @Req() req: Request) {
    await this.assertEnabled();
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    return this.chatService.findById(id, userId);
  }

  @Put('sessions/:id')
  async updateSession(
    @Param('id') id: string,
    @Body() dto: UpdateChatSessionDto,
    @Req() req: Request,
  ) {
    await this.assertEnabled();
    if (!dto.title || !dto.title.trim()) {
      throw new BadRequestException('title is required');
    }
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    return this.chatService.updateTitle(id, dto.title, userId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async deleteSession(@Param('id') id: string, @Req() req: Request): Promise<void> {
    await this.assertEnabled();
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
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
    @Req() req: Request,
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

    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    const session = await this.chatService.findById(id, userId);
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
    @Req() req: Request,
  ) {
    await this.assertEnabled();
    if (!dto?.content?.trim()) {
      throw new BadRequestException('content is required');
    }
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    const session = await this.chatService.findById(id, userId);
    const projectId = session.projectId.toString();
    const opts = await this.llm.getOptions();
    const { forContext, images, refs } = await this.loadAttachmentsForContext(projectId, dto.attachmentIds);
    const built = await this.context.build(projectId, dto.content, session.messages, {
      topK: opts.topK,
      historyLimit: opts.historyLimit,
      toolsEnabled: opts.toolsEnabled,
      attachments: forContext,
      images,
    });
    const useTools = opts.toolsEnabled && opts.toolsAllowlist.length > 0;
    return {
      projectId,
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
    @Req() req: Request,
  ) {
    await this.assertEnabled();
    if (!dto?.userContent?.trim()) {
      throw new BadRequestException('userContent is required');
    }
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;

    // Resolve attachment refs for the user message (browser-mode parity with sendMessage).
    let userAttachmentRefs: ChatAttachmentRef[] | undefined;
    if (dto.attachmentIds && dto.attachmentIds.length > 0) {
      const session = await this.chatService.findById(id, userId);
      const projectId = session.projectId.toString();
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
      });
    }
    return this.chatService.appendMessages(id, inputs, userId);
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
    @Req() req: Request,
  ) {
    await this.assertEnabled();
    if (!dto?.name) {
      throw new BadRequestException('name is required');
    }
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    const session = await this.chatService.findById(id, userId);
    // T-56: projectId IMMER aus Session, nie aus DTO/args — verhindert
    // dass ein User über seine eigene Session Tools gegen fremde Projekte
    // dispatcht. Das DTO-Feld wird ignoriert.
    const projectId = session.projectId.toString();
    const opts = await this.llm.getOptions();
    const rawArgs = (dto.arguments && typeof dto.arguments === 'object') ? dto.arguments : {};
    // Auch args.projectId überschreiben — der Browser-LLM darf nicht
    // manipulierte projectIds einschmuggeln.
    const args = { ...rawArgs, projectId };
    const result = await this.tools.execute(dto.name, args, { projectId }, opts.toolsAllowlist);
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
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertEnabled();
    if (!dto?.content?.trim()) {
      throw new BadRequestException('content is required');
    }

    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    const session = await this.chatService.findById(id, userId);
    const projectId = session.projectId.toString();

    const { forContext: attachmentsForContext, images: attachmentImages, refs: attachmentRefs } =
      await this.loadAttachmentsForContext(projectId, dto.attachmentIds);

    await this.chatService.appendMessage(id, {
      role: 'user',
      content: dto.content,
      attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
    }, userId);

    const afterUser = await this.chatService.findById(id, userId);
    const historyWithoutCurrent = afterUser.messages.slice(0, -1);
    const opts = await this.llm.getOptions();
    const built = await this.context.build(projectId, dto.content, historyWithoutCurrent, {
      topK: opts.topK,
      historyLimit: opts.historyLimit,
      toolsEnabled: opts.toolsEnabled,
      attachments: attachmentsForContext,
      images: attachmentImages,
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const flushHeaders = (res as Response & { flushHeaders?: () => void }).flushHeaders;
    if (typeof flushHeaders === 'function') flushHeaders.call(res);

    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on('close', onClose);

    send({ type: 'context', refs: built.contextRefs });

    const useTools = opts.toolsEnabled && opts.toolsAllowlist.length > 0;
    let fullResponse = '';
    const persistedToolCalls: ChatToolCallRecord[] = [];
    let errored = false;

    try {
      if (!useTools) {
        for await (const token of this.llm.streamChat(built.messages, {
          signal: abort.signal,
          images: built.images,
        })) {
          if (abort.signal.aborted) break;
          fullResponse += token;
          send({ type: 'token', content: token });
        }
        if (!abort.signal.aborted) send({ type: 'done' });
      } else {
        const tools = this.tools.getToolsForLlm(opts.toolsAllowlist);
        const conversation: LlmMessageWithTools[] = built.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const maxIter = opts.toolsMaxIterations;
        // Only attach images to the first iteration — once the model has seen them
        // and replied / issued a tool-call, follow-up turns don't need them re-sent.
        let imagesForIteration: LlmImageInput[] | undefined = built.images;

        for (let iter = 0; iter < maxIter; iter++) {
          if (abort.signal.aborted) break;
          const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
          let iterFinishReason: 'stop' | 'tool_calls' | 'length' | 'other' = 'other';
          let iterContent = '';

          for await (const event of this.llm.streamChatWithTools(conversation, tools, {
            signal: abort.signal,
            images: imagesForIteration,
          })) {
            if (abort.signal.aborted) break;
            if (event.type === 'content') {
              iterContent += event.delta;
              fullResponse += event.delta;
              send({ type: 'token', content: event.delta });
            } else if (event.type === 'tool_call') {
              pendingToolCalls.push(event);
            } else if (event.type === 'finish') {
              iterFinishReason = event.reason;
            }
          }

          if (abort.signal.aborted) break;

          if (iterFinishReason !== 'tool_calls' || pendingToolCalls.length === 0) {
            send({ type: 'done' });
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

          for (const tc of pendingToolCalls) {
            if (abort.signal.aborted) break;
            send({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });

            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
            } catch (err) {
              const error = `Invalid JSON arguments: ${(err as Error).message}`;
              send({ type: 'tool_result', id: tc.id, success: false, summary: error });
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.name,
                content: JSON.stringify({ error }),
              });
              persistedToolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments, success: false, error });
              continue;
            }

            const result = await this.tools.execute(tc.name, parsedArgs, { projectId }, opts.toolsAllowlist);
            const resultJson = JSON.stringify(result.success ? result.result : { error: result.error });
            const truncated = resultJson.length > MAX_TOOL_RESULT_CHARS
              ? resultJson.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated]'
              : resultJson;

            const summary = result.success
              ? this.summarizeResult(tc.name, result.result)
              : `error: ${result.error}`;
            send({ type: 'tool_result', id: tc.id, success: result.success, summary });

            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.name,
              content: truncated,
            });

            persistedToolCalls.push({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              result: truncated,
              success: result.success,
              error: result.error,
            });
          }

          if (iter === maxIter - 1) {
            send({ type: 'done', reason: 'max_iterations_reached' });
          }
          // After the first iteration the model has seen the images — further
          // tool-call rounds don't need to resend them.
          imagesForIteration = undefined;
        }
      }
    } catch (err) {
      errored = true;
      const message = (err as Error).message || 'LLM error';
      this.logger.warn(`Chat stream failed for session ${id}: ${message}`);
      send({ type: 'error', message });
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
    }

    if (!errored && fullResponse.trim()) {
      try {
        await this.chatService.appendMessage(id, {
          role: 'assistant',
          content: fullResponse,
          contextUsed: built.contextRefs,
          toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : undefined,
        }, userId);
      } catch (err) {
        this.logger.warn(
          `Failed to persist assistant message for session ${id}: ${(err as Error).message}`,
        );
      }
    }

    if (!res.writableEnded) res.end();
  }

  /** Short human-readable summary of a tool result for SSE/UI display */
  private summarizeResult(toolName: string, result: unknown): string {
    if (result == null) return 'empty';
    if (Array.isArray(result)) return `${result.length} items`;
    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      if (Array.isArray(obj.items)) return `${(obj.items as unknown[]).length} items`;
      if (typeof obj.count === 'number') return `${obj.count} items`;
      const keys = Object.keys(obj);
      return `${toolName}: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}`;
    }
    return String(result).slice(0, 80);
  }
}
