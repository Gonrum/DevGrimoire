import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Milestone, MilestoneSchema } from './schemas/milestone.schema';
import { MilestonesService } from './milestones.service';
import { MilestonesController } from './milestones.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Milestone.name, schema: MilestoneSchema }]),
  ],
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService],
})
export class MilestonesModule {}
