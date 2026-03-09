import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Research, ResearchSchema } from './schemas/research.schema';
import { ResearchService } from './research.service';
import { ResearchController } from './research.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Research.name, schema: ResearchSchema },
    ]),
  ],
  controllers: [ResearchController],
  providers: [ResearchService],
  exports: [ResearchService],
})
export class ResearchModule {}
