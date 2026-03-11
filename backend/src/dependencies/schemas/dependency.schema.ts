import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DependencyDocument = Dependency & Document;

export enum PackageManager {
  NPM = 'npm',
  COMPOSER = 'composer',
  PIP = 'pip',
  CARGO = 'cargo',
  GO = 'go',
  MAVEN = 'maven',
  NUGET = 'nuget',
  GEM = 'gem',
}

@Schema({ timestamps: true })
export class Dependency {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  version: string;

  @Prop()
  description?: string;

  @Prop({ required: true, enum: PackageManager })
  packageManager: PackageManager;

  @Prop({ default: false })
  devDependency: boolean;

  @Prop()
  category?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];
}

export const DependencySchema = SchemaFactory.createForClass(Dependency);

DependencySchema.index({ projectId: 1, name: 1, packageManager: 1 }, { unique: true });
DependencySchema.index({ projectId: 1, packageManager: 1 });
DependencySchema.index({ name: 'text', description: 'text' });
