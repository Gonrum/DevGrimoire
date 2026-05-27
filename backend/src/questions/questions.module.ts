import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Question, QuestionSchema } from './schemas/question.schema';
import { QuestionsService } from './questions.service';
import { QuestionsController } from './questions.controller';
import { QuestionsScheduler } from './questions.scheduler';
import { TodosModule } from '../todos/todos.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Question.name, schema: QuestionSchema },
    ]),
    forwardRef(() => TodosModule),
    NotificationsModule,
    KnowledgeModule,
    forwardRef(() => AuthModule),
  ],
  controllers: [QuestionsController],
  providers: [QuestionsService, QuestionsScheduler],
  exports: [QuestionsService],
})
export class QuestionsModule {}
