import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Release, ReleaseSchema } from './schemas/release.schema';
import { ReleasesService } from './releases.service';
import { ReleasesController } from './releases.controller';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { ProjectsModule } from '../projects/projects.module';
import { SecretsModule } from '../secrets/secrets.module';
import { CommitsModule } from '../commits/commits.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Release.name, schema: ReleaseSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
    ProjectsModule,
    SecretsModule,
    CommitsModule,
  ],
  controllers: [ReleasesController],
  providers: [ReleasesService],
  exports: [ReleasesService],
})
export class ReleasesModule {}
