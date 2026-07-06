import { Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';
import { SettingsModule } from '../settings/settings.module';
import { EncryptionService } from '../common/encryption.service';
import { BalancerModule } from '../balancer/balancer.module';

@Module({
  imports: [SettingsModule, BalancerModule],
  controllers: [RagController],
  providers: [RagService, EncryptionService],
  exports: [RagService],
})
export class RagModule {}
