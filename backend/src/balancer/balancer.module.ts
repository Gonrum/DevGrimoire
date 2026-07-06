import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LlmEndpoint, LlmEndpointSchema } from './schemas/llm-endpoint.schema';
import { EncryptionService } from '../common/encryption.service';
import { SettingsModule } from '../settings/settings.module';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmEndpointsController } from './llm-endpoints.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: LlmEndpoint.name, schema: LlmEndpointSchema }]),
    SettingsModule,
  ],
  controllers: [LlmEndpointsController],
  providers: [EncryptionService, LlmEndpointsService],
  exports: [LlmEndpointsService],
})
export class BalancerModule {}
