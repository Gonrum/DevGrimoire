import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { MilestonesService } from './milestones.service';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { MilestoneStatus } from './schemas/milestone.schema';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';
import { ImportPreviewDto, ImportApplyDto } from './dto/import-milestone.dto';
import { AiCompleteDto } from './dto/ai-complete.dto';

@Controller('milestones')
export class MilestonesController {
  constructor(private readonly milestonesService: MilestonesService) {}

  // ── Import endpoints (must be placed BEFORE `:id` routes) ────────────────

  @Post('import/preview')
  @HttpCode(200)
  importPreview(@Body() dto: ImportPreviewDto) {
    return this.milestonesService.parseMarkdown(dto.markdown);
  }

  @Post('import/apply')
  @HttpCode(201)
  importApply(@Body(ValidateProjectIdPipe) dto: ImportApplyDto) {
    return this.milestonesService.importFromParsed(dto.projectId, dto.parsed);
  }

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateMilestoneDto) {
    return this.milestonesService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId: string,
    @Query('status') status?: MilestoneStatus,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.milestonesService.findByProject(projectId, status, includeArchived === 'true');
  }

  @Post(':id/ai-complete')
  @HttpCode(200)
  aiComplete(@Param('id') id: string, @Body() dto: AiCompleteDto) {
    return this.milestonesService.aiComplete(id, dto.summaryMarkdown);
  }

  @Get(':id/export.md')
  async exportMarkdown(@Param('id') id: string, @Res() res: Response) {
    const { content, filename } = await this.milestonesService.exportAsMarkdown(id);

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.milestonesService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMilestoneDto) {
    return this.milestonesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.milestonesService.remove(id);
  }
}
