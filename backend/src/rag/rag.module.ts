import { Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';
import { SettingsModule } from '../settings/settings.module';
import { EncryptionService } from '../common/encryption.service';

@Module({
  imports: [SettingsModule],
  controllers: [RagController],
  providers: [RagService, EncryptionService],
  exports: [RagService],
})
export class RagModule {}
