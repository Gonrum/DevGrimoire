import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Todo, TodoSchema } from './schemas/todo.schema';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { TodosService } from './todos.service';
import { TodosController } from './todos.controller';
import { CountersModule } from '../counters/counters.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Todo.name, schema: TodoSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
    CountersModule,
  ],
  controllers: [TodosController],
  providers: [TodosService],
  exports: [TodosService],
})
export class TodosModule {}
