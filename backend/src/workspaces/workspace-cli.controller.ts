import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { WorkspaceCliAuthGuard } from './workspace-cli.guard';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceClient } from './workspace-client.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { LogsService } from '../logs/logs.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { TodosService } from '../todos/todos.service';
import { TodoPriority } from '../todos/schemas/todo.schema';

class DgSaveDto {
  @IsString() @MaxLength(2048)
  path!: string;

  @IsOptional() @IsString() @MaxLength(255)
  fileName?: string;

  @IsOptional() @IsString() @MaxLength(48)
  entityType?: string;

  @IsOptional() @IsString() @MaxLength(48)
  entityId?: string;

  @IsOptional() @IsString() @MaxLength(2048)
  description?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];
}

class DgLogDto {
  @IsEnum(['debug', 'info', 'warn', 'error'])
  level!: 'debug' | 'info' | 'warn' | 'error';

  @IsString() @MaxLength(8 * 1024)
  message!: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];
}

class DgNoteDto {
  @IsString() @MaxLength(255)
  topic!: string;

  @IsString() @MaxLength(64 * 1024)
  content!: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(64)
  category?: string;
}

class DgTodoDto {
  @IsString() @MaxLength(255)
  title!: string;

  @IsOptional() @IsString() @MaxLength(8 * 1024)
  description?: string;

  @IsOptional() @IsEnum(TodoPriority)
  priority?: TodoPriority;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsMongoId()
  milestoneId?: string;
}

/**
 * Endpoints called by the in-workspace `dg` CLI. Bypasses the global
 * JwtAuthGuard (via @Public) so the WorkspaceCliAuthGuard can run alone —
 * those JWTs are signed with the same secret but a different `sub`, so
 * they would not satisfy the user-JWT strategy anyway.
 *
 * Every write is scoped to `req.workspaceCli.projectId` — the route never
 * trusts client-supplied projectId.
 */
@Controller('internal/dg')
@Public()
@UseGuards(WorkspaceCliAuthGuard)
export class WorkspaceCliController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly workspaceClient: WorkspaceClient,
    private readonly attachments: AttachmentsService,
    private readonly logs: LogsService,
    private readonly knowledge: KnowledgeService,
    private readonly todos: TodosService,
  ) {}

  @Post('save')
  async save(@Req() req: Request, @Body() dto: DgSaveDto) {
    const { workspaceId, projectId } = req.workspaceCli!;
    const ws = await this.workspaces.findById(workspaceId);
    if (ws.projectId.toString() !== projectId) {
      throw new ForbiddenException('workspace/project mismatch');
    }
    const file = await this.workspaceClient.readBase64(workspaceId, dto.path);
    const fileName =
      dto.fileName ||
      dto.path.split('/').filter(Boolean).pop() ||
      'file';
    const att = await this.attachments.createFromBase64(
      {
        projectId,
        fileName,
        entityType: dto.entityType,
        entityId: dto.entityId,
        description: dto.description,
        tags: dto.tags,
      },
      file.contentBase64,
    );
    await this.workspaces.touch(workspaceId);
    return {
      saved: true,
      attachmentId: att._id.toString(),
      fileName,
      sizeBytes: file.size,
    };
  }

  @Post('log')
  async log(@Req() req: Request, @Body() dto: DgLogDto) {
    const { projectId, workspaceId } = req.workspaceCli!;
    const entry = await this.logs.create({
      projectId,
      level: dto.level,
      message: dto.message,
      service: 'workspace-cli',
      area: 'dg',
      tags: dto.tags ?? [`ws:${workspaceId}`],
      metadata: { workspaceId },
    });
    return { logged: true, id: entry._id.toString() };
  }

  @Post('note')
  async note(@Req() req: Request, @Body() dto: DgNoteDto) {
    const { projectId } = req.workspaceCli!;
    const entry = await this.knowledge.create({
      projectId,
      topic: dto.topic,
      content: dto.content,
      tags: dto.tags ?? [],
      category: dto.category,
    });
    return { saved: true, id: entry._id.toString(), topic: entry.topic };
  }

  @Post('todo')
  async todo(@Req() req: Request, @Body() dto: DgTodoDto) {
    const { projectId } = req.workspaceCli!;
    const entry = await this.todos.create({
      projectId,
      title: dto.title,
      description: dto.description,
      priority: dto.priority,
      tags: dto.tags,
      milestoneId: dto.milestoneId,
    });
    return {
      created: true,
      id: entry._id.toString(),
      number: entry.displayNumber,
      title: entry.title,
    };
  }

  @Post('whoami')
  whoami(@Req() req: Request) {
    return {
      workspaceId: req.workspaceCli!.workspaceId,
      projectId: req.workspaceCli!.projectId,
    };
  }
}
