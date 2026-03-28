import { GitRepository } from '../schemas/git-repository.schema';

export interface CommitStats {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

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
  changedFiles?: number;
}

export interface FetchCommitsResult {
  commits: NormalizedCommit[];
  etag?: string;
  notModified?: boolean;
}

export interface GitBranch {
  name: string;
  isDefault: boolean;
}

export interface GitProviderInterface {
  fetchCommits(
    config: GitRepository,
    token: string,
    since?: Date,
    etag?: string,
  ): Promise<FetchCommitsResult>;

  fetchCommitStats(
    config: GitRepository,
    token: string,
    sha: string,
  ): Promise<CommitStats>;

  validateToken(config: GitRepository, token: string): Promise<boolean>;

  fetchBranches(config: GitRepository, token: string): Promise<GitBranch[]>;
}
