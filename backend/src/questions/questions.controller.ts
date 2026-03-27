import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  Req,
} from '@nestjs/common';
import { QuestionsService } from './questions.service';
import { AnswerQuestionDto } from './dto/answer-question.dto';

@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Get('pending')
  findPending(@Req() req: any) {
    const userId = req.user?.userId;
    return this.questionsService.findPending(userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.questionsService.findById(id);
  }

  @Post(':id/answer')
  @HttpCode(200)
  answer(
    @Param('id') id: string,
    @Body() dto: AnswerQuestionDto,
    @Req() req: any,
  ) {
    const userId = req.user?.userId;
    return this.questionsService.answer(id, dto.answer, userId);
  }
}
