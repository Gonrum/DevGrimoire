import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { JwtModule } from '@nestjs/jwt';
import { Workspace, WorkspaceSchema } from './schemas/workspace.schema';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceFsController } from './workspace-fs.controller';
import { WorkspaceConfigController } from './workspace-config.controller';
import { WorkspaceLimitsService } from './workspace-limits.service';
import { DownloadActorService } from './download-actor.service';
import { WorkspaceCliController } from './workspace-cli.controller';
import { WorkspaceCliKubeController } from './workspace-cli-kube.controller';
import { WorkspaceCliSshController } from './workspace-cli-ssh.controller';
import { WorkspaceCliReqController } from './workspace-cli-req.controller';
import { WorkspaceClient } from './workspace-client.service';
import { WorkspaceFsBackends } from './fs/workspace-fs-backends.service';
import { SshWorkspaceAccess } from './ssh-workspace-access.service';
import { WorkspaceTtlScheduler } from './workspace-ttl.scheduler';
import { WorkspaceGitTokensService } from './workspace-git-tokens.service';
import { WorkspaceCliTokenService } from './workspace-cli-token.service';
import { WorkspaceCliAuthGuard } from './workspace-cli.guard';
import { LogsModule } from '../logs/logs.module';
import { SettingsModule } from '../settings/settings.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecretsModule } from '../secrets/secrets.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TodosModule } from '../todos/todos.module';
import { KubeModule } from '../kube/kube.module';
import { SshModule } from '../ssh/ssh.module';
import { HttpRequestsModule } from '../http-requests/http-requests.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { resolveJwtSecret } from '../common/jwt-secret';
import { JWT_ALGORITHM } from '../common/access-token';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Workspace.name, schema: WorkspaceSchema }]),
    HttpModule.register({ timeout: 60_000, maxRedirects: 0 }),
    // JwtService isn't exported from AuthModule — re-register it here with the
    // same secret so WorkspaceCliTokenService can sign/verify dg-CLI tokens
    // (T-168). Both instances share JWT_SECRET, so tokens are interchangeable.
    JwtModule.register({
      secret: resolveJwtSecret(),
      signOptions: { algorithm: JWT_ALGORITHM },
      verifyOptions: { algorithms: [JWT_ALGORITHM] },
    }),
    LogsModule,
    SettingsModule,
    ApiKeysModule,
    NotificationsModule,
    SecretsModule,
    AttachmentsModule,
    KnowledgeModule,
    TodosModule,
    // `dg kube` (C-3): Cluster-Zugriff aus der Shell läuft über das Backend.
    KubeModule,
    // `dg ssh` / `dg scp`: SFTP transfers via the backend, credentials stay there.
    SshModule,
    // `dg req`: saved workbench requests, sent by the backend (secrets stay there).
    HttpRequestsModule,
    EnvironmentsModule,
  ],
  controllers: [
    WorkspacesController,
    WorkspaceFsController,
    WorkspaceConfigController,
    WorkspaceCliController,
    WorkspaceCliKubeController,
    WorkspaceCliSshController,
    WorkspaceCliReqController,
  ],
  providers: [
    WorkspacesService,
    WorkspaceClient,
    WorkspaceLimitsService,
    WorkspaceFsBackends,
    DownloadActorService,
    SshWorkspaceAccess,
    WorkspaceTtlScheduler,
    WorkspaceGitTokensService,
    WorkspaceCliTokenService,
    WorkspaceCliAuthGuard,
  ],
  exports: [
    WorkspacesService,
    WorkspaceClient,
    WorkspaceLimitsService,
    SshWorkspaceAccess,
    WorkspaceTtlScheduler,
    WorkspaceGitTokensService,
    WorkspaceCliTokenService,
  ],
})
export class WorkspacesModule {}
