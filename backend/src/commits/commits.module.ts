import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Commit, CommitSchema } from './schemas/commit.schema';
import { CommitsService } from './commits.service';
import { CommitsController } from './commits.controller';
import { GitHubProviderService } from './providers/github-provider.service';
import { GitLabProviderService } from './providers/gitlab-provider.service';
import { CommitsScheduler } from './commits.scheduler';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Commit.name, schema: CommitSchema }]),
    SecretsModule,
  ],
  controllers: [CommitsController],
  providers: [CommitsService, GitHubProviderService, GitLabProviderService, CommitsScheduler],
  exports: [CommitsService],
})
export class CommitsModule {}
