import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Dependency, DependencySchema } from './schemas/dependency.schema';
import { DependenciesService } from './dependencies.service';
import { DependenciesController } from './dependencies.controller';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Dependency.name, schema: DependencySchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
  ],
  controllers: [DependenciesController],
  providers: [DependenciesService],
  exports: [DependenciesService],
})
export class DependenciesModule {}
