import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Todo, TodoSchema } from './schemas/todo.schema';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { Milestone, MilestoneSchema } from '../milestones/schemas/milestone.schema';
import { TodosService } from './todos.service';
import { TodosController } from './todos.controller';
import { CountersModule } from '../counters/counters.module';
import { CustomersModule } from '../customers/customers.module';
import { QuestionsModule } from '../questions/questions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Todo.name, schema: TodoSchema },
      { name: Project.name, schema: ProjectSchema },
      // Read-only: validates milestoneId on todo writes.
      { name: Milestone.name, schema: MilestoneSchema },
    ]),
    CountersModule,
    CustomersModule,
    forwardRef(() => QuestionsModule),
  ],
  controllers: [TodosController],
  providers: [TodosService],
  exports: [TodosService],
})
export class TodosModule {}
