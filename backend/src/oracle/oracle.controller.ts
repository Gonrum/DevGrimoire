import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  CommentOracleOnTodoDto,
  ConvertOracleToTodoDto,
  ListOracleSuggestionsDto,
  UpdateOracleStatusDto,
} from './dto/oracle.dto';
import { OracleService } from './oracle.service';

@Controller('oracle')
export class OracleController {
  constructor(private readonly oracle: OracleService) {}

  @Post('analyze/:projectId')
  @HttpCode(200)
  analyze(@Param('projectId') projectId: string) {
    return this.oracle.analyze(projectId);
  }

  @Get('suggestions')
  list(@Query() query: ListOracleSuggestionsDto) {
    return this.oracle.list(query);
  }

  @Get('suggestions/:id')
  get(@Param('id') id: string) {
    return this.oracle.findById(id);
  }

  @Post('suggestions/:id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateOracleStatusDto) {
    return this.oracle.updateStatus(id, dto.status, dto.note);
  }

  @Post('suggestions/:id/convert-to-todo')
  convertToTodo(@Param('id') id: string, @Body() dto: ConvertOracleToTodoDto) {
    return this.oracle.convertToTodo(id, dto);
  }

  @Post('suggestions/:id/comment-on-todo')
  commentOnTodo(@Param('id') id: string, @Body() dto: CommentOracleOnTodoDto) {
    return this.oracle.commentOnTodo(id, dto);
  }

  @Delete('suggestions/:id')
  remove(@Param('id') id: string) {
    return this.oracle.remove(id).then(() => ({ deleted: true, id }));
  }
}
