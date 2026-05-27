import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { QuestionsService } from './questions.service';
import { AnswerQuestionDto } from './dto/answer-question.dto';
import { CreateQuestionDto } from './dto/create-question.dto';
import { ConvertToKnowledgeDto } from './dto/convert-to-knowledge.dto';
import { QuestionDirection } from './schemas/question.schema';

const VALID_DIRECTIONS: QuestionDirection[] = ['agent_to_user', 'user_to_agent'];

interface AuthRequest {
  user?: { userId?: string };
}

@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Get('pending')
  findPending(
    @Req() req: AuthRequest,
    @Query('direction') direction?: string,
  ) {
    const userId = req.user?.userId;
    if (direction && !VALID_DIRECTIONS.includes(direction as QuestionDirection)) {
      throw new BadRequestException(`Invalid direction: ${direction}`);
    }
    // Default to agent_to_user: the global "Agent-Rückfrage"-Modal must only
    // surface questions the user is meant to answer. user_to_agent questions
    // belong to the agent-side inbox (or the todo detail view) and must not
    // pop up the answer dialog for the asker themselves.
    const effectiveDirection = (direction as QuestionDirection | undefined) ?? 'agent_to_user';
    return this.questionsService.findPending(userId, effectiveDirection);
  }

  /**
   * "Open" = not yet answered (pending or expired). Drives the dashboard
   * widget and the todo lila-mark aggregate query.
   */
  @Get('open')
  async findOpen(
    @Query('projectId') projectId?: string,
    @Query('direction') direction?: string,
    @Query('todoId') todoId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (direction && !VALID_DIRECTIONS.includes(direction as QuestionDirection)) {
      throw new BadRequestException(`Invalid direction: ${direction}`);
    }
    return this.questionsService.findOpen({
      projectId,
      direction: direction as QuestionDirection | undefined,
      todoId,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  /**
   * Aggregate map: { todoId -> { pending, expired, total, lastUpdatedAt } }.
   * Frontend calls this once per todo list/board and uses it to render the
   * lila accent on todos with open questions.
   */
  @Get('by-todos')
  byTodos(@Query('ids') ids?: string) {
    if (!ids) return {};
    const list = ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.questionsService.findOpenForTodos(list);
  }

  @Get('by-todo/:todoId')
  byTodo(
    @Param('todoId') todoId: string,
    @Query('includeAnswered') includeAnswered?: string,
  ) {
    const include = includeAnswered === undefined ? true : includeAnswered !== 'false';
    return this.questionsService.findByTodo(todoId, include);
  }

  /**
   * User-initiated follow-up question for an agent (T-247). Allowed even on
   * `done` todos. The corresponding todo status is intentionally NOT changed.
   */
  @Post('user-to-agent')
  @HttpCode(201)
  createUserQuestion(
    @Body() dto: CreateQuestionDto,
    @Req() req: AuthRequest,
  ) {
    const userId = req.user?.userId;
    return this.questionsService.create(
      { ...dto, direction: 'user_to_agent' },
      userId,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.questionsService.findById(id);
  }

  /**
   * Answer a question. M-30: this also accepts `expired` agent→user questions
   * — every authenticated user with project scope may still respond after the
   * agent's wait window has lapsed.
   */
  @Post(':id/answer')
  @HttpCode(200)
  answer(
    @Param('id') id: string,
    @Body() dto: AnswerQuestionDto,
    @Req() req: AuthRequest,
  ) {
    const userId = req.user?.userId;
    return this.questionsService.answer(id, dto.answer, { userId });
  }

  /**
   * Convert an answered question to a Knowledge entry (T-400).
   * Returns 400 if the question is not yet answered or has already been
   * converted. Returns 404 if the question does not exist.
   * The created Knowledge document is returned.
   */
  @Post(':id/convert-to-knowledge')
  @HttpCode(201)
  convertToKnowledge(
    @Param('id') id: string,
    @Body() dto: ConvertToKnowledgeDto,
  ) {
    return this.questionsService.convertToKnowledge(id, dto);
  }
}
