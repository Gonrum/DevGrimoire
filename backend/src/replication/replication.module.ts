import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { ReplicationQueue, ReplicationQueueSchema } from './schemas/replication-queue.schema';
import { ReplicationLog, ReplicationLogSchema } from './schemas/replication-log.schema';
import { ReplicationCounter, ReplicationCounterSchema } from './schemas/replication-counter.schema';
import { ReplicationApplied, ReplicationAppliedSchema } from './schemas/replication-applied.schema';
import { ReplicationPushService } from './replication-push.service';
import { ReplicationReceiveService } from './replication-receive.service';
import { ReplicationFullSyncService } from './replication-full-sync.service';
import { ReplicationPullService } from './replication-pull.service';
import { ReplicationController } from './replication.controller';
import { ReplicationScheduler } from './replication.scheduler';
import { ReplicationReadonlyGuard } from './replication-readonly.guard';
import { ReplicationCounterService } from './replication-counter.service';
import { ReplicationLogWriterService } from './replication-log-writer.service';
import { ReplicationSyncApplyService } from './replication-sync-apply.service';
import { SettingsModule } from '../settings/settings.module';
import { ProjectsModule } from '../projects/projects.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReplicationQueue.name, schema: ReplicationQueueSchema },
      { name: ReplicationLog.name, schema: ReplicationLogSchema },
      { name: ReplicationCounter.name, schema: ReplicationCounterSchema },
      { name: ReplicationApplied.name, schema: ReplicationAppliedSchema },
    ]),
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 3,
    }),
    SettingsModule,
    ProjectsModule,
    NotificationsModule,
  ],
  controllers: [ReplicationController],
  providers: [
    ReplicationPushService,
    ReplicationReceiveService,
    ReplicationFullSyncService,
    ReplicationPullService,
    ReplicationScheduler,
    ReplicationReadonlyGuard,
    ReplicationCounterService,
    ReplicationLogWriterService,
    ReplicationSyncApplyService,
  ],
  exports: [ReplicationReadonlyGuard],
})
export class ReplicationModule {}
