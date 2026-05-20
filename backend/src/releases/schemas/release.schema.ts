import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReleaseDocument = Release & Document;

export enum ReleaseType {
  MANUAL = 'manual',
  GITLAB = 'gitlab',
  GITHUB = 'github',
  GITEA = 'gitea',
}

export enum ReleasePlatform {
  ANDROID = 'android',
  IOS = 'ios',
  WEB = 'web',
  DESKTOP = 'desktop',
  DOCKER = 'docker',
  OTHER = 'other',
}

export enum ReleaseStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

@Schema()
export class ReleaseAsset {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  url: string;

  @Prop()
  size?: number;

  @Prop()
  format?: string;
}

export const ReleaseAssetSchema = SchemaFactory.createForClass(ReleaseAsset);

@Schema({ timestamps: true })
export class Release {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  version: string;

  @Prop()
  title?: string;

  @Prop()
  description?: string;

  @Prop({ enum: ReleaseType, default: ReleaseType.MANUAL })
  releaseType: ReleaseType;

  @Prop({ enum: ReleasePlatform, default: ReleasePlatform.OTHER })
  platform: ReleasePlatform;

  @Prop({ enum: ReleaseStatus, default: ReleaseStatus.DRAFT })
  status: ReleaseStatus;

  @Prop()
  downloadUrl?: string;

  @Prop({ enum: ['github', 'gitlab', 'gitea'] })
  provider?: 'github' | 'gitlab' | 'gitea';

  @Prop()
  providerReleaseId?: string;

  @Prop()
  tagName?: string;

  // Backwards-Compat — wird durch Migration auf neue Felder umgezogen.
  // Bleiben optional für Roll-Back-Sicherheit eine Release lang.
  @Prop()
  gitlabReleaseId?: string;

  @Prop()
  gitlabTagName?: string;

  @Prop({ type: [ReleaseAssetSchema], default: [] })
  assets: ReleaseAsset[];

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  repoLabel?: string;
}

export const ReleaseSchema = SchemaFactory.createForClass(Release);

ReleaseSchema.index({ projectId: 1, version: 1 }, { unique: true });
ReleaseSchema.index({ projectId: 1, status: 1 });
ReleaseSchema.index({ projectId: 1, platform: 1 });
ReleaseSchema.index({ projectId: 1, releaseType: 1 });
ReleaseSchema.index({ version: 'text', title: 'text', description: 'text' });
ReleaseSchema.index(
  { projectId: 1, provider: 1, providerReleaseId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      provider: { $exists: true },
      providerReleaseId: { $exists: true },
    },
  },
);
