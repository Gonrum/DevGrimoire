import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CommitDocument = HydratedDocument<Commit>;

export enum GitProvider {
  GITHUB = 'github',
  GITLAB = 'gitlab',
}

@Schema({ timestamps: true })
export class Commit {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, enum: GitProvider })
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
}

export const CommitSchema = SchemaFactory.createForClass(Commit);
CommitSchema.index({ projectId: 1, sha: 1 }, { unique: true });
CommitSchema.index({ projectId: 1, committedAt: -1 });
CommitSchema.index({ projectId: 1, provider: 1 });
CommitSchema.index({ projectId: 1, repoLabel: 1 });
CommitSchema.index({ message: 'text' });
