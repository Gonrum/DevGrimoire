import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Commit, CommitSchema } from './schemas/commit.schema';
import { CommitsService } from './commits.service';
import { CommitsController } from './commits.controller';
import { GitHubProviderService } from './providers/github-provider.service';
import { GitLabProviderService } from './providers/gitlab-provider.service';
import { GiteaProviderService } from './providers/gitea-provider.service';
import { GitProviderRegistry } from './providers/git-provider.registry';
import { CommitsScheduler } from './commits.scheduler';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Commit.name, schema: CommitSchema }]),
    SecretsModule,
  ],
  controllers: [CommitsController],
  providers: [
    CommitsService,
    CommitsScheduler,
    GitHubProviderService,
    GitLabProviderService,
    GiteaProviderService,
    GitProviderRegistry,
  ],
  exports: [CommitsService, GitProviderRegistry],
})
export class CommitsModule {}
