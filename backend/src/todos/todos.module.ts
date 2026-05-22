import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Todo, TodoSchema } from './schemas/todo.schema';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { Question, QuestionSchema } from '../questions/schemas/question.schema';
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
      { name: Question.name, schema: QuestionSchema },
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
