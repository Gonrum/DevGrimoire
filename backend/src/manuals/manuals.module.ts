import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Manual, ManualSchema } from './schemas/manual.schema';
import { ManualsService } from './manuals.service';
import { ManualsController } from './manuals.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Manual.name, schema: ManualSchema },
    ]),
  ],
  controllers: [ManualsController],
  providers: [ManualsService],
  exports: [ManualsService],
})
export class ManualsModule {}
