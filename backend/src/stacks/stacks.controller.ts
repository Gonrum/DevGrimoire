import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { StacksService } from './stacks.service';
import { CreateStackDto } from './dto/create-stack.dto';
import { UpdateStackDto } from './dto/update-stack.dto';
import { CreateStackEntryDto } from './dto/create-stack-entry.dto';
import { UpdateStackEntryDto } from './dto/update-stack-entry.dto';
import { ReorderEntriesDto } from './dto/reorder-entries.dto';

@Controller('stacks')
export class StacksController {
  constructor(private readonly stacksService: StacksService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateStackDto) {
    return this.stacksService.create(dto);
  }

  @Get()
  findAll() {
    return this.stacksService.findAll();
  }

  @Get(':id/export.md')
  async exportStack(@Param('id') id: string, @Res() res: Response) {
    const { content, filename } = await this.stacksService.exportAsMarkdown(id);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  @Get(':id/entries/:entryId/export.md')
  async exportEntry(@Param('id') id: string, @Param('entryId') entryId: string, @Res() res: Response) {
    const { content, filename } = await this.stacksService.exportAsMarkdown(id, entryId);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stacksService.findById(id);
  }

  @Patch(':id/reorder')
  reorder(@Param('id') id: string, @Body() dto: ReorderEntriesDto) {
    return this.stacksService.reorderEntries(id, dto.entryIds);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStackDto) {
    return this.stacksService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.stacksService.remove(id);
  }

  @Post(':id/entries')
  addEntry(@Param('id') id: string, @Body() dto: CreateStackEntryDto) {
    return this.stacksService.addEntry(id, dto);
  }

  @Patch(':id/entries/:entryId')
  updateEntry(@Param('id') id: string, @Param('entryId') entryId: string, @Body() dto: UpdateStackEntryDto) {
    return this.stacksService.updateEntry(id, entryId, dto);
  }

  @Delete(':id/entries/:entryId')
  @HttpCode(204)
  removeEntry(@Param('id') id: string, @Param('entryId') entryId: string) {
    return this.stacksService.removeEntry(id, entryId);
  }
}
