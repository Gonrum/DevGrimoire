import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Todo, TodoDocument } from '../todos/schemas/todo.schema';
import { Milestone, MilestoneDocument } from '../milestones/schemas/milestone.schema';
import { Project, ProjectDocument } from '../projects/schemas/project.schema';
import { CountersService } from './counters.service';
import { formatEntityNumber } from '../common/number-format';

@Injectable()
export class NumberMigrationService implements OnModuleInit {
  private readonly logger = new Logger(NumberMigrationService.name);

  constructor(
    @InjectModel(Todo.name) private todoModel: Model<TodoDocument>,
    @InjectModel(Milestone.name) private milestoneModel: Model<MilestoneDocument>,
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>,
    private countersService: CountersService,
  ) {}

  async onModuleInit() {
    await this.migrateAll();
  }

  private async migrateAll() {
    const unnumberedTodos = await this.todoModel.countDocuments({ number: { $exists: false } }).exec();
    const unnumberedMilestones = await this.milestoneModel.countDocuments({ number: { $exists: false } }).exec();

    if (unnumberedTodos === 0 && unnumberedMilestones === 0) return;

    this.logger.log(`Migrating numbers: ${unnumberedTodos} todos, ${unnumberedMilestones} milestones`);

    const projects = await this.projectModel.find().exec();
    for (const project of projects) {
      const pid = project._id.toString();
      await this.migrateTodos(pid, project);
      await this.migrateMilestones(pid, project);
    }

    this.logger.log('Number migration complete');
  }

  private async migrateTodos(projectId: string, project: ProjectDocument) {
    const format = project.todoNumberFormat || '{type}-{n}';
    const unnumbered = await this.todoModel
      .find({ projectId, number: { $exists: false } })
      .sort({ createdAt: 1 })
      .exec();

    if (unnumbered.length === 0) return;

    const existing = await this.todoModel
      .findOne({ projectId, number: { $exists: true } })
      .sort({ number: -1 })
      .exec();
    let seq = existing?.number ?? 0;

    for (const doc of unnumbered) {
      seq++;
      const displayNumber = formatEntityNumber(format, seq, project.name, 'T');
      await this.todoModel.updateOne({ _id: doc._id }, { $set: { number: seq, displayNumber } }).exec();
    }

    await this.countersService.setSequence(projectId, 'todo', seq);
  }

  private async migrateMilestones(projectId: string, project: ProjectDocument) {
    const format = project.milestoneNumberFormat || '{type}-{n}';
    const unnumbered = await this.milestoneModel
      .find({ projectId, number: { $exists: false } })
      .sort({ createdAt: 1 })
      .exec();

    if (unnumbered.length === 0) return;

    const existing = await this.milestoneModel
      .findOne({ projectId, number: { $exists: true } })
      .sort({ number: -1 })
      .exec();
    let seq = existing?.number ?? 0;

    for (const doc of unnumbered) {
      seq++;
      const displayNumber = formatEntityNumber(format, seq, project.name, 'M');
      await this.milestoneModel.updateOne({ _id: doc._id }, { $set: { number: seq, displayNumber } }).exec();
    }

    await this.countersService.setSequence(projectId, 'milestone', seq);
  }
}
