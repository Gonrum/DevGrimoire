import { BadRequestException, Injectable } from '@nestjs/common';
import { GitHubProviderService } from './github-provider.service';
import { GitLabProviderService } from './gitlab-provider.service';
import { GiteaProviderService } from './gitea-provider.service';
import { GitProviderInterface } from './git-provider.interface';
import { GitProvider } from '../schemas/git-repository.schema';

@Injectable()
export class GitProviderRegistry {
  constructor(
    private readonly github: GitHubProviderService,
    private readonly gitlab: GitLabProviderService,
    private readonly gitea: GiteaProviderService,
  ) {}

  get(provider: GitProvider): GitProviderInterface {
    switch (provider) {
      case 'github':
        return this.github;
      case 'gitlab':
        return this.gitlab;
      case 'gitea':
        return this.gitea;
      default:
        throw new BadRequestException(`Unknown provider: ${provider}`);
    }
  }
}
