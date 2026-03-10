import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Counter, CounterSchema } from './schemas/counter.schema';
import { Todo, TodoSchema } from '../todos/schemas/todo.schema';
import { Milestone, MilestoneSchema } from '../milestones/schemas/milestone.schema';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { CountersService } from './counters.service';
import { NumberMigrationService } from './number-migration.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Counter.name, schema: CounterSchema },
      { name: Todo.name, schema: TodoSchema },
      { name: Milestone.name, schema: MilestoneSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
  ],
  providers: [CountersService, NumberMigrationService],
  exports: [CountersService, MongooseModule],
})
export class CountersModule {}
