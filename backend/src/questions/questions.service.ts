import {
  Injectable,
  NotFoundException,
  BadRequestException,
  GoneException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Question, QuestionDocument } from './schemas/question.schema';
import { CreateQuestionDto } from './dto/create-question.dto';
import { TodosService } from '../todos/todos.service';
import { NotificationsService } from '../notifications/notifications.service';

export const QUESTION_CREATED = 'question.created';
export const QUESTION_ANSWERED = 'question.answered';

@Injectable()
export class QuestionsService {
  constructor(
    @InjectModel(Question.name)
    private questionModel: Model<QuestionDocument>,
    private eventEmitter: EventEmitter2,
    private todosService: TodosService,
    private notificationsService: NotificationsService,
  ) {}

  async create(
    dto: CreateQuestionDto,
    userId?: string,
  ): Promise<QuestionDocument> {
    const timeoutMs = (dto.timeoutSeconds || 300) * 1000;
    const expiresAt = new Date(Date.now() + timeoutMs);

    // If todoId is set, derive projectId from the todo
    let projectId = dto.projectId;
    if (dto.todoId && !projectId) {
      const todo = await this.todosService.findById(dto.todoId);
      projectId = todo.projectId.toString();
    }

    const entry = await this.questionModel.create({
      question: dto.question,
      options: dto.options || [],
      context: dto.context,
      todoId: dto.todoId ? new Types.ObjectId(dto.todoId) : undefined,
      projectId: projectId ? new Types.ObjectId(projectId) : undefined,
      targetUserId: dto.targetUserId
        ? new Types.ObjectId(dto.targetUserId)
        : userId
          ? new Types.ObjectId(userId)
          : undefined,
      createdByUserId: userId ? new Types.ObjectId(userId) : undefined,
      timeoutMs,
      expiresAt,
    });

    this.eventEmitter.emit(QUESTION_CREATED, {
      questionId: entry._id.toString(),
      question: entry.question,
      options: entry.options,
      context: entry.context,
      todoId: entry.todoId?.toString() || null,
      projectId: entry.projectId?.toString() || null,
      targetUserId: entry.targetUserId?.toString() || null,
      expiresAt: entry.expiresAt.toISOString(),
    });

    // Send push notification
    const title = 'Agent hat eine Frage';
    const body =
      entry.question.length > 100
        ? entry.question.slice(0, 97) + '...'
        : entry.question;
    const url = entry.todoId
      ? `/projects/${projectId}/todos/${entry.todoId}`
      : undefined;

    await this.notificationsService
      .create(title, body, url, 'question')
      .catch(() => {
        // Push not available — ignore
      });

    return entry;
  }

  async answer(
    id: string,
    answer: string,
    userId?: string,
  ): Promise<QuestionDocument> {
    const entry = await this.questionModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Question ${id} not found`);

    if (entry.status === 'answered') {
      throw new BadRequestException('Question already answered');
    }
    if (entry.status === 'expired' || entry.expiresAt < new Date()) {
      throw new GoneException('Question has expired');
    }

    // Validate answer against options if set
    if (entry.options.length > 0 && !entry.options.includes(answer)) {
      throw new BadRequestException(
        `Answer must be one of: ${entry.options.join(', ')}`,
      );
    }

    entry.answer = answer;
    entry.status = 'answered';
    entry.answeredAt = new Date();
    if (userId) {
      entry.answeredByUserId = new Types.ObjectId(userId);
    }
    await entry.save();

    // Document question + answer as comment on todo
    if (entry.todoId) {
      const commentText = `**Agent-Rückfrage:** ${entry.question}\n**Antwort:** ${answer}`;
      await this.todosService
        .addComment(entry.todoId.toString(), commentText, 'user')
        .catch(() => {
          // Todo might have been deleted — ignore
        });
    }

    this.eventEmitter.emit(QUESTION_ANSWERED, {
      questionId: id,
      answer,
      answeredByUserId: userId || null,
    });

    return entry;
  }

  async findById(id: string): Promise<QuestionDocument> {
    const entry = await this.questionModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Question ${id} not found`);
    return entry;
  }

  async findPending(userId?: string): Promise<QuestionDocument[]> {
    const now = new Date();
    const filter: Record<string, unknown> = {
      status: 'pending',
      expiresAt: { $gt: now },
    };
    if (userId) {
      // Show questions targeted at this user + broadcast questions (no targetUserId)
      filter.$or = [
        { targetUserId: new Types.ObjectId(userId) },
        { targetUserId: { $exists: false } },
        { targetUserId: null },
      ];
    }
    return this.questionModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async waitForAnswer(
    id: string,
    timeoutMs: number,
  ): Promise<{ answered: boolean; answer?: string; answeredBy?: string }> {
    const pollInterval = 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const entry = await this.questionModel.findById(id).exec();
      if (!entry) {
        return { answered: false };
      }
      if (entry.status === 'answered' && entry.answer != null) {
        return {
          answered: true,
          answer: entry.answer,
          answeredBy: entry.answeredByUserId?.toString(),
        };
      }
      if (entry.status === 'expired' || entry.expiresAt < new Date()) {
        return { answered: false };
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Mark as expired
    await this.questionModel
      .findByIdAndUpdate(id, { status: 'expired' })
      .exec();
    return { answered: false };
  }
}
