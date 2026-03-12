import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Soul, SoulSchema } from './schemas/soul.schema';
import { SoulsService } from './souls.service';
import { SoulsController } from './souls.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Soul.name, schema: SoulSchema },
    ]),
  ],
  controllers: [SoulsController],
  providers: [SoulsService],
  exports: [SoulsService],
})
export class SoulsModule {}
