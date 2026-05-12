import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ConvertDocProposalToTodoDto,
  CreateDocUpdateProposalDto,
  ListDocUpdateProposalsDto,
  UpdateDocUpdateProposalStatusDto,
} from './dto/doc-update-proposal.dto';
import { DocUpdateProposalsService } from './doc-update-proposals.service';

@Controller('doc-update-proposals')
export class DocUpdateProposalsController {
  constructor(private readonly proposals: DocUpdateProposalsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateDocUpdateProposalDto) {
    return this.proposals.create(dto);
  }

  @Get()
  list(@Query() query: ListDocUpdateProposalsDto) {
    return this.proposals.list(query);
  }

  @Post('detect/todo/:todoId')
  detectForTodo(@Param('todoId') todoId: string) {
    return this.proposals.detectForTodo(todoId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.proposals.findById(id);
  }

  @Post(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateDocUpdateProposalStatusDto) {
    return this.proposals.updateStatus(id, dto.status, dto.note);
  }

  @Post(':id/convert-to-todo')
  convertToTodo(@Param('id') id: string, @Body() dto: ConvertDocProposalToTodoDto) {
    return this.proposals.convertToTodo(id, dto);
  }
}
