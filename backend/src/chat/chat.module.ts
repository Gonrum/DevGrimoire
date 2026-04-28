import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatSession, ChatSessionSchema } from './schemas/chat-session.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { ChatService } from './chat.service';
import { ChatLlmService } from './chat-llm.service';
import { ChatContextService } from './chat-context.service';
import { ChatToolsService } from './chat-tools';
import { ChatController } from './chat.controller';
import { EncryptionService } from '../common/encryption.service';
import { SettingsModule } from '../settings/settings.module';
import { RagModule } from '../rag/rag.module';
import { TodosModule } from '../todos/todos.module';
import { MilestonesModule } from '../milestones/milestones.module';
import { ChangelogModule } from '../changelog/changelog.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ResearchModule } from '../research/research.module';
import { ManualsModule } from '../manuals/manuals.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SchemasModule } from '../schemas/schemas.module';
import { DependenciesModule } from '../dependencies/dependencies.module';
import { FeaturesModule } from '../features/features.module';
import { LogsModule } from '../logs/logs.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { MinioModule } from '../minio/minio.module';
import { WebSearchModule } from '../web-search/web-search.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SnippetsModule } from '../snippets/snippets.module';
import { RecurringTasksModule } from '../recurring-tasks/recurring-tasks.module';
import { ReleasesModule } from '../releases/releases.module';
import { SoulsModule } from '../souls/souls.module';
import { CommitsModule } from '../commits/commits.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatSession.name, schema: ChatSessionSchema },
      { name: User.name, schema: UserSchema },
    ]),
    SettingsModule,
    RagModule,
    TodosModule,
    MilestonesModule,
    ChangelogModule,
    KnowledgeModule,
    ResearchModule,
    ManualsModule,
    SessionsModule,
    SchemasModule,
    DependenciesModule,
    FeaturesModule,
    LogsModule,
    AttachmentsModule,
    MinioModule,
    WebSearchModule,
    WorkspacesModule,
    SnippetsModule,
    RecurringTasksModule,
    ReleasesModule,
    SoulsModule,
    CommitsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatLlmService, ChatContextService, ChatToolsService, EncryptionService],
  exports: [ChatService, ChatLlmService, ChatContextService],
})
export class ChatModule {}
