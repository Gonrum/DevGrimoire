import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PushSubscriptionEntry, PushSubscriptionSchema } from './schemas/push-subscription.schema';
import { PushService } from './push.service';
import { PushController } from './push.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PushSubscriptionEntry.name, schema: PushSubscriptionSchema }]),
  ],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
