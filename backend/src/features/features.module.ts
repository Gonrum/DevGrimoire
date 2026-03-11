import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Feature, FeatureSchema } from './schemas/feature.schema';
import { FeaturesService } from './features.service';
import { FeaturesController } from './features.controller';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Feature.name, schema: FeatureSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
  ],
  controllers: [FeaturesController],
  providers: [FeaturesService],
  exports: [FeaturesService],
})
export class FeaturesModule {}
