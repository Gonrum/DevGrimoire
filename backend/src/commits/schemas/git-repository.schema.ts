import { Schema as MongooseSchema } from 'mongoose';

export const GitRepositorySchema = new MongooseSchema(
  {
    provider: { type: String, enum: ['github', 'gitlab'], required: true },
    baseUrl: { type: String, default: '' },
    owner: { type: String, default: '' },
    repo: { type: String, default: '' },
    gitlabProjectId: { type: String, default: '' },
    defaultBranch: { type: String, default: 'main' },
    tokenSecretId: { type: String },
    syncEnabled: { type: Boolean, default: true },
    lastSyncAt: { type: Date },
    lastSyncSha: { type: String },
    lastEtag: { type: String },
  },
  { _id: true },
);

export interface GitRepository {
  _id?: string;
  provider: 'github' | 'gitlab';
  baseUrl: string;
  owner: string;
  repo: string;
  gitlabProjectId: string;
  defaultBranch: string;
  tokenSecretId?: string;
  syncEnabled: boolean;
  lastSyncAt?: Date;
  lastSyncSha?: string;
  lastEtag?: string;
}
