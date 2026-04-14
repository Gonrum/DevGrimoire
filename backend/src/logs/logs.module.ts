import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LogEntry, LogEntrySchema } from './schemas/log-entry.schema';
import { LogsService } from './logs.service';
import { LogsController } from './logs.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: LogEntry.name, schema: LogEntrySchema }]),
  ],
  controllers: [LogsController],
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
