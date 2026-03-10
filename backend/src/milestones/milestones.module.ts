import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Milestone, MilestoneSchema } from './schemas/milestone.schema';
import { Changelog, ChangelogSchema } from '../changelog/schemas/changelog.schema';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { MilestonesService } from './milestones.service';
import { MilestonesController } from './milestones.controller';
import { CountersModule } from '../counters/counters.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Milestone.name, schema: MilestoneSchema },
      { name: Changelog.name, schema: ChangelogSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
    CountersModule,
  ],
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService],
})
export class MilestonesModule {}
