import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateValidationReportDto, ListValidationReportsDto } from './dto/validation-report.dto';
import { ValidationReport, ValidationReportDocument } from './schemas/validation-report.schema';
import { PROJECT_CHANGED } from '../events/project-event';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1***'],
  [/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s&]+/gi, '$1***'],
  [/(cv_)[a-f0-9]{32,}/gi, '$1***'],
];

function truncate(value: string | undefined, max: number): { value?: string; truncated: boolean } {
  if (!value) return { value, truncated: false };
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}…`, truncated: true };
}

export function maskValidationText(value: string | undefined): string | undefined {
  if (!value) return value;
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

@Injectable()
export class ValidationReportsService {
  constructor(
    @InjectModel(ValidationReport.name)
    private readonly reportModel: Model<ValidationReportDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateValidationReportDto): Promise<ValidationReportDocument> {
    const summary = truncate(maskValidationText(dto.summary), 8_000);
    const output = truncate(maskValidationText(dto.outputSnippet), 16_000);
    const report = await this.reportModel.create({
      ...dto,
      projectId: new Types.ObjectId(dto.projectId),
      todoId: dto.todoId ? new Types.ObjectId(dto.todoId) : undefined,
      commitId: dto.commitId ? new Types.ObjectId(dto.commitId) : undefined,
      workflowRunId: dto.workflowRunId ? new Types.ObjectId(dto.workflowRunId) : undefined,
      summary: summary.value,
      outputSnippet: output.value,
      truncated: Boolean(dto.truncated || summary.truncated || output.truncated),
      tags: dto.tags ?? [],
    });

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: report.projectId.toString(),
      entity: 'validation-report',
      action: 'created',
      entityId: report._id.toString(),
      summary: `Validation "${report.name}" ${report.status}`,
    });

    return report;
  }

  async list(query: ListValidationReportsDto): Promise<ValidationReportDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.projectId) filter.projectId = new Types.ObjectId(query.projectId);
    if (query.todoId) filter.todoId = new Types.ObjectId(query.todoId);
    if (query.commitId) filter.commitId = new Types.ObjectId(query.commitId);
    if (query.workflowRunId) filter.workflowRunId = new Types.ObjectId(query.workflowRunId);
    if (query.status) filter.status = query.status;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.reportModel.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
  }

  async latestForTodo(todoId: string): Promise<ValidationReportDocument | null> {
    return this.reportModel.findOne({ todoId: new Types.ObjectId(todoId) }).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<ValidationReportDocument> {
    const report = await this.reportModel.findById(id).exec();
    if (!report) throw new NotFoundException(`ValidationReport ${id} not found`);
    return report;
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.reportModel.deleteMany({ projectId: new Types.ObjectId(projectId) }).exec();
  }
}
