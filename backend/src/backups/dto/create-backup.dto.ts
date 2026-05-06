import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { BackupMode } from '../schemas/backup-job.schema';

export class CreateBackupDto {
  @IsEnum(BackupMode)
  @IsOptional()
  mode?: BackupMode;

  @IsBoolean()
  @IsOptional()
  includeAttachments?: boolean;
}
