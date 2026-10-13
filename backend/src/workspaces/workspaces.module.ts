import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { JwtModule } from '@nestjs/jwt';
import { Workspace, WorkspaceSchema } from './schemas/workspace.schema';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceCliController } from './workspace-cli.controller';
import { WorkspaceCliKubeController } from './workspace-cli-kube.controller';
import { WorkspaceClient } from './workspace-client.service';
import { WorkspaceTtlScheduler } from './workspace-ttl.scheduler';
import { WorkspaceGitTokensService } from './workspace-git-tokens.service';
import { WorkspaceCliTokenService } from './workspace-cli-token.service';
import { WorkspaceCliAuthGuard } from './workspace-cli.guard';
import { LogsModule } from '../logs/logs.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecretsModule } from '../secrets/secrets.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TodosModule } from '../todos/todos.module';
import { KubeModule } from '../kube/kube.module';
import { resolveJwtSecret } from '../common/jwt-secret';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Workspace.name, schema: WorkspaceSchema }]),
    HttpModule.register({ timeout: 60_000, maxRedirects: 0 }),
    // JwtService isn't exported from AuthModule — re-register it here with the
    // same secret so WorkspaceCliTokenService can sign/verify dg-CLI tokens
    // (T-168). Both instances share JWT_SECRET, so tokens are interchangeable.
    JwtModule.register({
      secret: resolveJwtSecret(),
    }),
    LogsModule,
    SettingsModule,
    NotificationsModule,
    SecretsModule,
    AttachmentsModule,
    KnowledgeModule,
    TodosModule,
    // `dg kube` (C-3): Cluster-Zugriff aus der Shell läuft über das Backend.
    KubeModule,
  ],
  controllers: [WorkspacesController, WorkspaceCliController, WorkspaceCliKubeController],
  providers: [
    WorkspacesService,
    WorkspaceClient,
    WorkspaceTtlScheduler,
    WorkspaceGitTokensService,
    WorkspaceCliTokenService,
    WorkspaceCliAuthGuard,
  ],
  exports: [
    WorkspacesService,
    WorkspaceClient,
    WorkspaceTtlScheduler,
    WorkspaceGitTokensService,
    WorkspaceCliTokenService,
  ],
})
export class WorkspacesModule {}
