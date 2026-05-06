import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BackupJob, BackupJobSchema } from './schemas/backup-job.schema';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BackupJob.name, schema: BackupJobSchema },
    ]),
  ],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule {}
