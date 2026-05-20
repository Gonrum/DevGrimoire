import { Schema as MongooseSchema } from 'mongoose';

export type GitProvider = 'github' | 'gitlab' | 'gitea';

export const GitRepositorySchema = new MongooseSchema(
  {
    provider: { type: String, enum: ['github', 'gitlab', 'gitea'], required: true },
    label: { type: String, default: '' },
    baseUrl: { type: String, default: '' },
    owner: { type: String, default: '' },
    repo: { type: String, default: '' },
    gitlabProjectId: { type: String, default: '' },
    defaultBranch: { type: String, default: 'main' },
    tokenSecretId: { type: String },
    syncEnabled: { type: Boolean, default: true },
    allowPrivateHost: { type: Boolean, default: false },
    lastSyncAt: { type: Date },
    lastSyncSha: { type: String },
    lastEtag: { type: String },
  },
  { _id: true },
);

export interface GitRepository {
  _id?: string;
  provider: GitProvider;
  label: string;
  baseUrl: string;
  owner: string;
  repo: string;
  gitlabProjectId: string;
  defaultBranch: string;
  tokenSecretId?: string;
  syncEnabled: boolean;
  allowPrivateHost: boolean;
  lastSyncAt?: Date;
  lastSyncSha?: string;
  lastEtag?: string;
}
