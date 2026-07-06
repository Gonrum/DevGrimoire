import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LlmEndpoint, LlmEndpointSchema } from './schemas/llm-endpoint.schema';
import { EncryptionService } from '../common/encryption.service';
import { SettingsModule } from '../settings/settings.module';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmEndpointsController } from './llm-endpoints.controller';
import { LlmHealthService } from './llm-health.service';
import { EndpointAllocator } from './endpoint-allocator.service';
import { StreamRelay } from './stream-relay.service';
import { LlmClient } from './llm-client.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: LlmEndpoint.name, schema: LlmEndpointSchema }]),
    SettingsModule,
  ],
  controllers: [LlmEndpointsController],
  providers: [EncryptionService, LlmEndpointsService, LlmHealthService, EndpointAllocator, StreamRelay, LlmClient],
  exports: [LlmEndpointsService, LlmHealthService, EndpointAllocator, StreamRelay, LlmClient],
})
export class BalancerModule {}
