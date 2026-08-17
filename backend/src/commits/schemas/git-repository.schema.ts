import { Schema as MongooseSchema } from 'mongoose';

/**
 * Die **eine** Liste der unterstützten Git-Hosts. Typ, Mongoose-Enum und
 * class-validator lesen alle von hier, damit sie nicht auseinanderlaufen
 * können: `commit.schema.ts` hatte parallel ein eigenes `enum GitProvider`
 * **ohne** `gitea` — Gitea-Commits gingen nur deshalb durch, weil
 * `findOneAndUpdate` ohne `runValidators` keine Enum-Prüfung fährt.
 */
export const GIT_PROVIDERS = ['github', 'gitlab', 'gitea'] as const;

export type GitProvider = (typeof GIT_PROVIDERS)[number];

export const GitRepositorySchema = new MongooseSchema(
  {
    provider: { type: String, enum: [...GIT_PROVIDERS], required: true },
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
