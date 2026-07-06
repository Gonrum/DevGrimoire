import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { LlmEndpoint, LlmEndpointSchema } from './schemas/llm-endpoint.schema';
import { EncryptionService } from '../common/encryption.service';
import { SettingsModule } from '../settings/settings.module';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmEndpointsController } from './llm-endpoints.controller';
import { LlmHealthService } from './llm-health.service';
import { EndpointAllocator } from './endpoint-allocator.service';
import { StreamRelay } from './stream-relay.service';
import { LlmClient } from './llm-client.service';
import { LlmQueueService } from './llm-queue.service';
import { GatewayProcessor } from './gateway.processor';
import { BalancerGateway } from './balancer-gateway.service';
import { BALANCER_QUEUE } from './balancer.types';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: LlmEndpoint.name, schema: LlmEndpointSchema }]),
    SettingsModule,
    BullModule.registerQueue({ name: BALANCER_QUEUE }),
  ],
  controllers: [LlmEndpointsController],
  providers: [
    EncryptionService, LlmEndpointsService, LlmHealthService, EndpointAllocator, StreamRelay, LlmClient,
    LlmQueueService, GatewayProcessor, BalancerGateway,
  ],
  exports: [LlmEndpointsService, LlmHealthService, EndpointAllocator, StreamRelay, LlmClient, BalancerGateway],
})
export class BalancerModule {}
