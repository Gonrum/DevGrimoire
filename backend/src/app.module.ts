import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { ProjectsModule } from './projects/projects.module';
import { TodosModule } from './todos/todos.module';
import { SessionsModule } from './sessions/sessions.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { ChangelogModule } from './changelog/changelog.module';
import { MilestonesModule } from './milestones/milestones.module';
import { EventsModule } from './events/events.module';
import { ActivitiesModule } from './activities/activities.module';
import { PushModule } from './push/push.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { EnvironmentsModule } from './environments/environments.module';
import { SecretsModule } from './secrets/secrets.module';
import { ManualsModule } from './manuals/manuals.module';
import { ResearchModule } from './research/research.module';
import { ResearchSessionsModule } from './research-sessions/research-sessions.module';
import { SettingsModule } from './settings/settings.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SearchModule } from './search/search.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { McpMetaModule } from './mcp-meta/mcp-meta.module';
import { SchemasModule } from './schemas/schemas.module';
import { DependenciesModule } from './dependencies/dependencies.module';
import { FeaturesModule } from './features/features.module';
import { SoulsModule } from './souls/souls.module';
import { CommitsModule } from './commits/commits.module';
import { ProjectTransferModule } from './project-transfer/project-transfer.module';
import { CustomerTransferModule } from './customer-transfer/customer-transfer.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { RagModule } from './rag/rag.module';
import { RecurringTasksModule } from './recurring-tasks/recurring-tasks.module';
import { SnippetsModule } from './snippets/snippets.module';
import { MinioModule } from './minio/minio.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { ReplicationModule } from './replication/replication.module';
import { ReplicationReadonlyGuard } from './replication/replication-readonly.guard';
import { RequestContextInterceptor } from './common/request-context.interceptor';
import { QuestionsModule } from './questions/questions.module';
import { LogsModule } from './logs/logs.module';
import { ReleasesModule } from './releases/releases.module';
import { ChatModule } from './chat/chat.module';
import { WebSearchModule } from './web-search/web-search.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { CustomersModule } from './customers/customers.module';
import { ContactsModule } from './contacts/contacts.module';
import { BackupsModule } from './backups/backups.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { AgentRolesModule } from './agent-roles/agent-roles.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { ValidationReportsModule } from './validation-reports/validation-reports.module';
import { DocUpdateProposalsModule } from './doc-update-proposals/doc-update-proposals.module';
import { KnowledgeGraphModule } from './knowledge-graph/knowledge-graph.module';
import { OracleModule } from './oracle/oracle.module';
import { CustomerTemplatesModule } from './customer-templates/customer-templates.module';
import { NotesModule } from './notes/notes.module';
import { SshModule } from './ssh/ssh.module';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required');
}

@Module({
  imports: [
    MongooseModule.forRoot(MONGODB_URI),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ProjectsModule,
    TodosModule,
    SessionsModule,
    KnowledgeModule,
    ChangelogModule,
    MilestonesModule,
    EventsModule,
    ActivitiesModule,
    PushModule,
    AuthModule,
    EnvironmentsModule,
    SecretsModule,
    ManualsModule,
    ResearchModule,
    ResearchSessionsModule,
    SettingsModule,
    NotificationsModule,
    SearchModule,
    ApiKeysModule,
    McpMetaModule,
    SchemasModule,
    DependenciesModule,
    FeaturesModule,
    SoulsModule,
    CommitsModule,
    ProjectTransferModule,
    CustomerTransferModule,
    AuditLogModule,
    RagModule,
    RecurringTasksModule,
    WorkflowsModule,
    ValidationReportsModule,
    DocUpdateProposalsModule,
    KnowledgeGraphModule,
    OracleModule,
    CustomerTemplatesModule,
    SnippetsModule,
    MinioModule,
    AttachmentsModule,
    ReplicationModule,
    QuestionsModule,
    LogsModule,
    ReleasesModule,
    ChatModule,
    WebSearchModule,
    WorkspacesModule,
    CustomersModule,
    ContactsModule,
    BackupsModule,
    MonitoringModule,
    AgentRolesModule,
    NotesModule,
    SshModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ReplicationReadonlyGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
