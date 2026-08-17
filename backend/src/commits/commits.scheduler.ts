import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CommitsService } from './commits.service';
import { ProjectsService } from '../projects/projects.service';
import { GitRepository } from './schemas/git-repository.schema';

@Injectable()
export class CommitsScheduler {
  private readonly logger = new Logger(CommitsScheduler.name);

  constructor(
    private readonly commitsService: CommitsService,
    private readonly projectsService: ProjectsService,
  ) {}

  @Cron('0 */15 * * * *') // Every 15 minutes
  async syncAllProjects() {
    const projects = await this.projectsService.findAll(true);

    for (const project of projects) {
      // `Project.gitRepositories` ist als `GitRepository[]` deklariert —
      // `toObject()` liefert das Feld korrekt getypt, ein Cast wäre nur
      // Typverlust.
      const repos: GitRepository[] = project.toObject().gitRepositories || [];
      const hasSyncEnabled = repos.some((r) => r.syncEnabled && Boolean(r.tokenSecretId));
      if (!hasSyncEnabled) continue;

      try {
        const result = await this.commitsService.syncAllForProject(project._id.toString());
        if (result.totalNewCommits > 0) {
          this.logger.log(`${project.name}: ${result.totalNewCommits} new commit(s) synced`);
        }
      } catch (err) {
        this.logger.error(`Sync failed for ${project.name}: ${err}`);
      }
    }
  }
}
