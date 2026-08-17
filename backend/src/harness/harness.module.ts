import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Harness, HarnessSchema } from './schemas/harness.schema';
import { HarnessService } from './harness.service';

/**
 * Harness definitions (M-51 / H1). Controllers land in T-439, the resolving
 * service in T-438 — this module currently exposes the persistence layer only.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Harness.name, schema: HarnessSchema }])],
  providers: [HarnessService],
  exports: [HarnessService],
})
export class HarnessModule {}
