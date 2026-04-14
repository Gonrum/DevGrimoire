import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import {
  ChatSession,
  ChatSessionDocument,
  ChatMessage,
  ChatContextRef,
  ChatToolCallRecord,
  ChatAttachmentRef,
} from './schemas/chat-session.schema';
import { User, UserDocument, UserRole } from '../auth/schemas/user.schema';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';

interface AppendMessageInput {
  role: ChatMessage['role'];
  content: string;
  contextUsed?: ChatContextRef[];
  toolCalls?: ChatToolCallRecord[];
  attachments?: ChatAttachmentRef[];
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
        `Migrated ${result.modifiedCount} legacy chat session(s) to admin user "${admin.username}" (${admin._id}).`,
      );
    } catch (err) {
      this.logger.warn(`Legacy chat session migration failed: ${(err as Error).message}`);
    }
  }

  async createSession(projectId: string, userId: string, title?: string): Promise<ChatSessionDocument> {
    const session = await this.chatModel.create({
      projectId,
      userId,
      title: title?.trim() || this.defaultTitle(),
      messages: [],
    });
    this.emit(projectId, session._id.toString(), 'created', userId, `Chat "${session.title}" erstellt`);
    return session;
  }

  async listSessions(
    projectId: string,
    userId: string,
    options: { includeArchived?: boolean; limit?: number; offset?: number } = {},
  ): Promise<ChatSessionDocument[]> {
    const filter: Record<string, unknown> = { projectId, userId };
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
      return payload;
    });
    const filter: Record<string, unknown> = { _id: id };
    if (userId) filter.userId = userId;
    const session = await this.chatModel
      .findOneAndUpdate(filter, { $push: { messages: { $each: payloads } } }, { new: true })
      .exec();
    if (!session) throw new NotFoundException(`Chat session ${id} not found`);
    this.emit(session.projectId.toString(), id, 'updated', session.userId?.toString());
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
    this.emit(session.projectId.toString(), id, 'updated', session.userId?.toString());
    return session;
  }

  async deleteSession(id: string, userId?: string): Promise<void> {
    const filter: Record<string, unknown> = { _id: id };
    if (userId) filter.userId = userId;
    const deleted = await this.chatModel.findOneAndDelete(filter).exec();
    if (!deleted) throw new NotFoundException(`Chat session ${id} not found`);
    this.emit(deleted.projectId.toString(), id, 'deleted', deleted.userId?.toString());
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
    } catch (err) {
      this.logger.warn(
        `Cascade delete failed for project ${event.entityId}: ${(err as Error).message}`,
      );
    }
  }

  private emit(
    projectId: string,
    entityId: string,
    action: ProjectChangeEvent['action'],
    userId?: string,
    summary?: string,
  ) {
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId,
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
