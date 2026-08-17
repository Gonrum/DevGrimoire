import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { GIT_PROVIDERS, GitProvider } from './git-repository.schema';

export type CommitDocument = HydratedDocument<Commit>;

@Schema({ timestamps: true })
export class Commit {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  /**
   * Provider-Liste kommt aus `git-repository.schema.ts` — dort steht die
   * einzige Definition. Früher stand hier ein eigenes `enum GitProvider` mit
   * nur GITHUB/GITLAB: das Mongoose-Enum dieses Feldes kannte `gitea` nicht,
   * obwohl der Sync es schreibt.
   */
  @Prop({ required: true, enum: [...GIT_PROVIDERS] })
  provider: GitProvider;

  @Prop({ required: true })
  sha: string;

  @Prop({ required: true })
  message: string;

  @Prop({ required: true })
  authorName: string;

  @Prop()
  authorEmail: string;

  @Prop({ required: true })
  committedAt: Date;

  @Prop()
  url: string;

  @Prop()
  branch: string;

  @Prop({ type: Number })
  repoIndex: number;

  @Prop()
  repoLabel: string;

  @Prop({ type: Number })
  additions: number;

  @Prop({ type: Number })
  deletions: number;

  @Prop({ type: Number })
  changedFiles: number;
}

export const CommitSchema = SchemaFactory.createForClass(Commit);
CommitSchema.index({ projectId: 1, sha: 1 }, { unique: true });
CommitSchema.index({ projectId: 1, committedAt: -1 });
CommitSchema.index({ projectId: 1, provider: 1 });
CommitSchema.index({ projectId: 1, repoLabel: 1 });
CommitSchema.index({ message: 'text' });
