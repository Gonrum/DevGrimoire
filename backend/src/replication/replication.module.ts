import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { ReplicationQueue, ReplicationQueueSchema } from './schemas/replication-queue.schema';
import { ReplicationPushService } from './replication-push.service';
import { ReplicationReceiveService } from './replication-receive.service';
import { ReplicationFullSyncService } from './replication-full-sync.service';
import { ReplicationPullService } from './replication-pull.service';
import { ReplicationController } from './replication.controller';
import { ReplicationScheduler } from './replication.scheduler';
import { ReplicationReadonlyGuard } from './replication-readonly.guard';
import { SettingsModule } from '../settings/settings.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReplicationQueue.name, schema: ReplicationQueueSchema },
    ]),
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 3,
    }),
    SettingsModule,
    ProjectsModule,
  ],
  controllers: [ReplicationController],
  providers: [
    ReplicationPushService,
    ReplicationReceiveService,
    ReplicationFullSyncService,
    ReplicationPullService,
    ReplicationScheduler,
    ReplicationReadonlyGuard,
  ],
  exports: [ReplicationReadonlyGuard],
})
export class ReplicationModule {}
