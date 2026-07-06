import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { LlmEndpoint, LlmEndpointSchema } from './schemas/llm-endpoint.schema';
import { LlmUsageRecord, LlmUsageSchema } from './schemas/llm-usage.schema';
import { EncryptionService } from '../common/encryption.service';
import { SettingsModule } from '../settings/settings.module';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmEndpointsController } from './llm-endpoints.controller';
import { LlmHealthService } from './llm-health.service';
import { EndpointAllocator } from './endpoint-allocator.service';
import { StreamRelay } from './stream-relay.service';
import { LlmClient } from './llm-client.service';
import { LlmUsageService } from './llm-usage.service';
import { LlmQueueService } from './llm-queue.service';
import { GatewayProcessor } from './gateway.processor';
import { BalancerGateway } from './balancer-gateway.service';
import { ChatRunner } from './chat-runner.service';
import { BALANCER_QUEUE } from './balancer.types';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LlmEndpoint.name, schema: LlmEndpointSchema },
      { name: LlmUsageRecord.name, schema: LlmUsageSchema },
    ]),
    SettingsModule,
    BullModule.registerQueue({ name: BALANCER_QUEUE }),
  ],
  controllers: [LlmEndpointsController],
  providers: [
    EncryptionService, LlmEndpointsService, LlmHealthService, EndpointAllocator, StreamRelay, LlmClient,
    LlmUsageService, LlmQueueService, GatewayProcessor, BalancerGateway, ChatRunner,
  ],
  exports: [
    LlmEndpointsService, LlmHealthService, EndpointAllocator, StreamRelay, LlmClient, LlmUsageService,
    BalancerGateway,
  ],
})
export class BalancerModule {}
