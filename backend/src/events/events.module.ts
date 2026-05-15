import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsBusService } from './events-bus.service';

@Module({
  controllers: [EventsController],
  providers: [EventsBusService],
  exports: [EventsBusService],
})
export class EventsModule {}
