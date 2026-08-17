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
    }
    // Der `switch` ist über GitProvider vollständig, für TS ist `provider` hier
    // also `never` — ein Template-Literal darauf wird abgelehnt. Die Defensive
    // bleibt trotzdem: ein Aufruf aus untypisiertem Code (MCP-Argument, DB-Wert
    // aus einer älteren Version) landet zur Laufzeit sehr wohl hier.
    throw new BadRequestException(`Unknown provider: ${String(provider)}`);
  }
}
