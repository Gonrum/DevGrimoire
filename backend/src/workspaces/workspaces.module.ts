import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { Workspace, WorkspaceSchema } from './schemas/workspace.schema';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceClient } from './workspace-client.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Workspace.name, schema: WorkspaceSchema }]),
    HttpModule.register({ timeout: 60_000, maxRedirects: 0 }),
  ],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceClient],
  exports: [WorkspacesService, WorkspaceClient],
})
export class WorkspacesModule {}
