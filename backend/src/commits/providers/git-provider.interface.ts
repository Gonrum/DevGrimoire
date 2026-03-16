import { GitRepository } from '../schemas/git-repository.schema';

export interface NormalizedCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail?: string;
  committedAt: Date;
  url: string;
  branch?: string;
  additions?: number;
  deletions?: number;
}

export interface FetchCommitsResult {
  commits: NormalizedCommit[];
  etag?: string;
  notModified?: boolean;
}

export interface GitProviderInterface {
  fetchCommits(
    config: GitRepository,
    token: string,
    since?: Date,
    etag?: string,
  ): Promise<FetchCommitsResult>;

  validateToken(config: GitRepository, token: string): Promise<boolean>;
}
