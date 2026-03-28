import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RecurringTask, RecurringTaskSchema } from './schemas/recurring-task.schema';
import { RecurringTasksService } from './recurring-tasks.service';
import { RecurringTasksController } from './recurring-tasks.controller';
import { RecurringTasksScheduler } from './recurring-tasks.scheduler';
import { TodosModule } from '../todos/todos.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RecurringTask.name, schema: RecurringTaskSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
    TodosModule,
    NotificationsModule,
  ],
  controllers: [RecurringTasksController],
  providers: [RecurringTasksService, RecurringTasksScheduler],
  exports: [RecurringTasksService],
})
export class RecurringTasksModule {}
