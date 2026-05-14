import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BackupJob, BackupJobSchema } from './schemas/backup-job.schema';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BackupJob.name, schema: BackupJobSchema },
    ]),
    NotificationsModule,
  ],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule {}
