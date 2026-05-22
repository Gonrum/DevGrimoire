import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Milestone, MilestoneDocument, MilestoneStatus } from './schemas/milestone.schema';
import { Changelog, ChangelogDocument } from '../changelog/schemas/changelog.schema';
import { Project, ProjectDocument } from '../projects/schemas/project.schema';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { CountersService } from '../counters/counters.service';
import { formatEntityNumber } from '../common/number-format';
import { projectIdFilter } from '../common/project-id-filter';
import { TodosService } from '../todos/todos.service';

@Injectable()
export class MilestonesService {
  constructor(
    @InjectModel(Milestone.name) private milestoneModel: Model<MilestoneDocument>,
    @InjectModel(Changelog.name) private changelogModel: Model<ChangelogDocument>,
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>,
    private countersService: CountersService,
    private eventEmitter: EventEmitter2,
    private todosService: TodosService,
  ) {}

  async findByNumber(projectId: string, number: number): Promise<MilestoneDocument> {
    const ms = await this.milestoneModel.findOne({ projectId: projectIdFilter(projectId), number }).exec();
    if (!ms) throw new NotFoundException(`Milestone #${number} not found in project ${projectId}`);
    return ms;
  }

  async findByDisplayNumber(projectId: string, displayNumber: string): Promise<MilestoneDocument> {
    const ms = await this.milestoneModel.findOne({ projectId: projectIdFilter(projectId), displayNumber }).exec();
    if (!ms) throw new NotFoundException(`Milestone "${displayNumber}" not found in project ${projectId}`);
    return ms;
  }

  async resolveId(args: { id?: string; projectId?: string; number?: string }): Promise<string> {
    if (args.id) return args.id;
    if (!args.number || !args.projectId) {
      throw new BadRequestException('Either id or number+projectId must be provided');
    }
    const num = parseInt(args.number, 10);
    const ms = isNaN(num)
      ? await this.findByDisplayNumber(args.projectId, args.number)
      : await this.findByNumber(args.projectId, num);
    return ms._id.toString();
  }

  async create(dto: CreateMilestoneDto): Promise<MilestoneDocument> {
    const project = await this.projectModel.findById(dto.projectId).exec();
    if (!project) throw new NotFoundException(`Project ${dto.projectId} not found`);
    const seq = await this.countersService.getNextSequence(dto.projectId, 'milestone');
    const displayNumber = formatEntityNumber(
      project.milestoneNumberFormat || '{type}-{n}',
      seq,
      project.name,
      'M',
    );
    const milestone = await this.milestoneModel.create({ ...dto, number: seq, displayNumber });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: milestone.projectId.toString(),
      entity: 'milestone',
      action: 'created',
      entityId: milestone._id.toString(),
      summary: `Milestone "${milestone.name}" erstellt`,
    });
    return milestone;
  }

  async findByProject(projectId: string, status?: MilestoneStatus, includeArchived?: boolean): Promise<MilestoneDocument[]> {
    const query: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    if (status) query.status = status;
    if (!includeArchived) query.archived = { $ne: true };
    return this.milestoneModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<MilestoneDocument> {
    const milestone = await this.milestoneModel.findById(id).exec();
    if (!milestone) throw new NotFoundException(`Milestone ${id} not found`);
    return milestone;
  }

  async update(id: string, dto: UpdateMilestoneDto): Promise<MilestoneDocument> {
    // When setting status to done, require a changelogId
    if (dto.status === MilestoneStatus.DONE) {
      const current = await this.milestoneModel.findById(id).exec();
      if (!current) throw new NotFoundException(`Milestone ${id} not found`);

      const changelogId = dto.changelogId || current.changelogId?.toString();
      if (!changelogId) {
        throw new BadRequestException(
          'Milestone kann nicht auf "done" gesetzt werden ohne einen Changelog-Eintrag. ' +
          'Erstelle zuerst einen Changelog (changelog_add) und übergib die changelogId.',
        );
      }

      // Verify changelog exists
      const changelog = await this.changelogModel.findById(changelogId).exec();
      if (!changelog) {
        throw new BadRequestException(`Changelog ${changelogId} nicht gefunden.`);
      }

      // Verify changelog is not already used by another milestone
      const other = await this.milestoneModel.findOne({
        changelogId,
        _id: { $ne: id },
      }).exec();
      if (other) {
        throw new BadRequestException(
          `Changelog ${changelogId} ist bereits dem Milestone "${other.name}" zugeordnet. Erstelle einen neuen Changelog-Eintrag.`,
        );
      }
    }

    const milestone = await this.milestoneModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!milestone) throw new NotFoundException(`Milestone ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: milestone.projectId.toString(),
      entity: 'milestone',
      action: 'updated',
      entityId: id,
      summary: `Milestone "${milestone.name}" aktualisiert${dto.status ? ': Status → ' + dto.status : ''}`,
    });
    return milestone;
  }

  async remove(id: string): Promise<void> {
    const result = await this.milestoneModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Milestone ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'milestone',
      action: 'deleted',
      entityId: id,
      summary: `Milestone "${result.name}" gelöscht`,
    });
  }

  async exportAsMarkdown(milestoneId: string): Promise<{ content: string; filename: string }> {
    const milestone = await this.findById(milestoneId);
    const todos = await this.todosService.findAll({ milestoneId });

    const lines: string[] = [];

    // Header
    const displayNumber = milestone.displayNumber ?? '';
    const name = milestone.name ?? '';
    lines.push(`# ${displayNumber} ${name}`.trim());
    lines.push('');

    // Meta block — Milestone has no tags field
    lines.push(`> Status: ${milestone.status}`);
    lines.push('');

    if (milestone.description) {
      lines.push(milestone.description);
      lines.push('');
    }

    // Todos
    lines.push('## Todos');
    lines.push('');

    if (todos.length === 0) {
      lines.push('_No todos linked to this milestone._');
      lines.push('');
    } else {
      for (const todo of todos) {
        lines.push(`### ${todo.displayNumber ?? ''} ${todo.title}`.trim());
        lines.push('');

        const todoTagsStr = Array.isArray(todo.tags) && todo.tags.length > 0 ? todo.tags.join(', ') : '';
        lines.push(`- Status: \`${todo.status}\``);
        lines.push(`- Priority: \`${todo.priority ?? 'medium'}\``);
        if (todoTagsStr) lines.push(`- Tags: ${todoTagsStr}`);
        lines.push('');

        if (todo.description) {
          lines.push(todo.description);
          lines.push('');
        }

        if (todo.userStories) {
          lines.push('#### User Stories');
          lines.push('');
          lines.push(todo.userStories);
          lines.push('');
        }

        const criteria = todo.acceptanceCriteria ?? [];
        if (criteria.length > 0) {
          lines.push('#### Acceptance Criteria');
          lines.push('');
          for (const c of criteria) {
            lines.push(`- [${c.done ? 'x' : ' '}] ${c.text}`);
          }
          lines.push('');
        }

        if (todo.outOfScope) {
          lines.push('#### Out of Scope');
          lines.push('');
          lines.push(todo.outOfScope);
          lines.push('');
        }

        if (todo.edgeCases) {
          lines.push('#### Edge Cases');
          lines.push('');
          lines.push(todo.edgeCases);
          lines.push('');
        }

        lines.push('---');
        lines.push('');
      }
    }

    const slugDisplay = (milestone.displayNumber ?? '').replace(/[^a-zA-Z0-9_-]/g, '-');
    const slugName = (milestone.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename = [slugDisplay, slugName].filter(Boolean).join('-') + '.md';

    return { content: lines.join('\n'), filename };
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.milestoneModel.deleteMany({ projectId }).exec();
  }
}
