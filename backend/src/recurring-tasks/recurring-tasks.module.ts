import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RecurringTask, RecurringTaskSchema } from './schemas/recurring-task.schema';
import { RecurringTasksService } from './recurring-tasks.service';
import { RecurringTasksController } from './recurring-tasks.controller';
import { RecurringTasksScheduler } from './recurring-tasks.scheduler';
import { TodosModule } from '../todos/todos.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomersModule } from '../customers/customers.module';
import { ChatModule } from '../chat/chat.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RecurringTask.name, schema: RecurringTaskSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
    TodosModule,
    NotificationsModule,
    CustomersModule,
    ChatModule,
    WorkflowsModule,
  ],
  controllers: [RecurringTasksController],
  providers: [RecurringTasksService, RecurringTasksScheduler],
  exports: [RecurringTasksService],
})
export class RecurringTasksModule {}
