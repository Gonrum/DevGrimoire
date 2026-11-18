import { forwardRef, Module } from '@nestjs/common';
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
import { User, UserSchema } from '../auth/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RecurringTask.name, schema: RecurringTaskSchema },
      { name: Project.name, schema: ProjectSchema },
      // The scheduler loads the owning user to run actions under that user's
      // actor (scope checks apply instead of the internal no-actor bypass).
      { name: User.name, schema: UserSchema },
    ]),
    TodosModule,
    NotificationsModule,
    CustomersModule,
    forwardRef(() => ChatModule),
    forwardRef(() => WorkflowsModule),
  ],
  controllers: [RecurringTasksController],
  providers: [RecurringTasksService, RecurringTasksScheduler],
  exports: [RecurringTasksService],
})
export class RecurringTasksModule {}
