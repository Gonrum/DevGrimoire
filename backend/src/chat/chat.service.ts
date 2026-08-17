import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import {
  ChatSession,
  ChatSessionDocument,
  ChatMessage,
  ChatContextRef,
  ChatResponseMetrics,
  ChatToolCallRecord,
  ChatAttachmentRef,
} from './schemas/chat-session.schema';
import { User, UserDocument, UserRole } from '../auth/schemas/user.schema';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { errorMessage } from '../common/narrow';

interface AppendMessageInput {
  role: ChatMessage['role'];
  content: string;
  contextUsed?: ChatContextRef[];
  toolCalls?: ChatToolCallRecord[];
  attachments?: ChatAttachmentRef[];
  metrics?: ChatResponseMetrics;
}

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectModel(ChatSession.name)
    private readonly chatModel: Model<ChatSessionDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.migrateLegacySessions();
  }

  /**
   * One-time migration: chat sessions created before per-user scoping (M-7)
   * have no userId. Assign them to the first admin so they don't disappear
   * from the UI. If no admin exists, the orphans are left as-is — they will
   * fail any user-scoped query, which is the safe default.
   */
  private async migrateLegacySessions(): Promise<void> {
    try {
      const orphanCount = await this.chatModel.countDocuments({ userId: { $exists: false } }).exec();
      if (orphanCount === 0) return;
      const admin = await this.userModel.findOne({ role: UserRole.ADMIN }).exec();
      if (!admin) {
        this.logger.warn(
          `Found ${orphanCount} legacy chat session(s) without userId, but no admin user exists to claim them.`,
        );
        return;
      }
      const result = await this.chatModel
        .updateMany({ userId: { $exists: false } }, { $set: { userId: admin._id } })
        .exec();
      this.logger.log(
        `Migrated ${result.modifiedCount} legacy chat session(s) to admin user "${admin.username}" (${String(admin._id)}).`,
      );
    } catch (err: unknown) {
      this.logger.warn(`Legacy chat session migration failed: ${errorMessage(err)}`);
    }
  }

  async createSession(
    owner: { projectId?: string; customerId?: string },
    userId: string,
    title?: string,
  ): Promise<ChatSessionDocument> {
    if (!owner.projectId && !owner.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (owner.projectId && owner.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    const session = await this.chatModel.create({
      projectId: owner.projectId,
      customerId: owner.customerId,
      userId,
      title: title?.trim() || this.defaultTitle(),
      messages: [],
    });
    this.emit(owner.projectId || null, session._id.toString(), 'created', userId, `Chat "${session.title}" erstellt`, owner.customerId || null);
    return session;
  }

  async listSessions(
    owner: { projectId?: string; customerId?: string },
    userId: string,
    options: { includeArchived?: boolean; limit?: number; offset?: number } = {},
  ): Promise<ChatSessionDocument[]> {
    if (!owner.projectId && !owner.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    const filter: Record<string, unknown> = { userId };
    if (owner.projectId) filter.projectId = owner.projectId;
    if (owner.customerId) filter.customerId = owner.customerId;
    if (!options.includeArchived) filter.archived = { $ne: true };
    let query = this.chatModel.find(filter).sort({ updatedAt: -1 });
    if (options.offset) query = query.skip(options.offset);
    if (options.limit) query = query.limit(options.limit);
    return query.exec();
  }

  /**
   * Find a session by id. If userId is provided, the session must be owned by
   * that user — otherwise NotFoundException is thrown (same response as
   * "doesn't exist" so we don't leak existence to other users).
   */
  async findById(id: string, userId?: string): Promise<ChatSessionDocument> {
    const session = await this.chatModel.findById(id).exec();
    if (!session) throw new NotFoundException(`Chat session ${id} not found`);
    if (userId && session.userId?.toString() !== userId) {
      throw new NotFoundException(`Chat session ${id} not found`);
    }
    return session;
  }

  async appendMessage(
    id: string,
    input: AppendMessageInput,
    userId?: string,
  ): Promise<ChatSessionDocument> {
    return this.appendMessages(id, [input], userId);
  }

  async appendMessages(
    id: string,
    inputs: AppendMessageInput[],
    userId?: string,
  ): Promise<ChatSessionDocument> {
    if (inputs.length === 0) {
      return this.findById(id, userId);
    }
    const payloads = inputs.map((input) => {
      const payload: Partial<ChatMessage> = {
        role: input.role,
        content: input.content,
        timestamp: new Date(),
      };
      if (input.contextUsed && input.contextUsed.length > 0) {
        payload.contextUsed = input.contextUsed;
      }
      if (input.toolCalls && input.toolCalls.length > 0) {
        payload.toolCalls = input.toolCalls;
      }
      if (input.attachments && input.attachments.length > 0) {
        payload.attachments = input.attachments;
      }
      if (input.metrics) {
        payload.metrics = input.metrics;
      }
      return payload;
    });
    const filter: Record<string, unknown> = { _id: id };
    if (userId) filter.userId = userId;
    const session = await this.chatModel
      .findOneAndUpdate(filter, { $push: { messages: { $each: payloads } } }, { new: true })
      .exec();
    if (!session) throw new NotFoundException(`Chat session ${id} not found`);
    this.emit(session.projectId?.toString() || null, id, 'updated', session.userId?.toString(), undefined, session.customerId?.toString() || null);
    return session;
  }

  async updateTitle(id: string, title: string, userId?: string): Promise<ChatSessionDocument> {
    const trimmed = title.trim();
    if (!trimmed) throw new BadRequestException('title cannot be empty');
    const filter: Record<string, unknown> = { _id: id };
    if (userId) filter.userId = userId;
    const session = await this.chatModel
      .findOneAndUpdate(filter, { title: trimmed }, { new: true })
      .exec();
    if (!session) throw new NotFoundException(`Chat session ${id} not found`);
    this.emit(session.projectId?.toString() || null, id, 'updated', session.userId?.toString(), undefined, session.customerId?.toString() || null);
    return session;
  }

  async deleteSession(id: string, userId?: string): Promise<void> {
    const filter: Record<string, unknown> = { _id: id };
    if (userId) filter.userId = userId;
    const deleted = await this.chatModel.findOneAndDelete(filter).exec();
    if (!deleted) throw new NotFoundException(`Chat session ${id} not found`);
    this.emit(deleted.projectId?.toString() || null, id, 'deleted', deleted.userId?.toString(), undefined, deleted.customerId?.toString() || null);
  }

  async removeByProject(projectId: string): Promise<number> {
    const result = await this.chatModel.deleteMany({ projectId }).exec();
    return result.deletedCount ?? 0;
  }

  @OnEvent(PROJECT_CHANGED)
  async onProjectChange(event: ProjectChangeEvent): Promise<void> {
    if (event.entity !== 'project' || event.action !== 'deleted' || !event.entityId) return;
    try {
      const removed = await this.removeByProject(event.entityId);
      if (removed > 0) {
        this.logger.log(`Cascade-deleted ${removed} chat session(s) for project ${event.entityId}`);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Cascade delete failed for project ${event.entityId}: ${errorMessage(err)}`,
      );
    }
  }

  private emit(
    projectId: string | null,
    entityId: string,
    action: ProjectChangeEvent['action'],
    userId?: string,
    summary?: string,
    customerId?: string | null,
  ) {
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId,
      customerId,
      entity: 'chat',
      action,
      entityId,
      summary,
      userId,
    });
  }

  private defaultTitle(): string {
    return `Chat ${new Date().toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
}
