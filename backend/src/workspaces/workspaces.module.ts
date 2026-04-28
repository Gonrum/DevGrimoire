import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { Workspace, WorkspaceSchema } from './schemas/workspace.schema';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceClient } from './workspace-client.service';
import { WorkspaceTtlScheduler } from './workspace-ttl.scheduler';
import { LogsModule } from '../logs/logs.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Workspace.name, schema: WorkspaceSchema }]),
    HttpModule.register({ timeout: 60_000, maxRedirects: 0 }),
    LogsModule,
    SettingsModule,
    NotificationsModule,
  ],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceClient, WorkspaceTtlScheduler],
  exports: [WorkspacesService, WorkspaceClient, WorkspaceTtlScheduler],
})
export class WorkspacesModule {}
