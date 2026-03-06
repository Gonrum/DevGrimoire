import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProjectDocument = HydratedDocument<Project>;

@Schema({ timestamps: true })
export class Project {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop()
  path: string;

  @Prop()
  description: string;

  @Prop({ type: [String], default: [] })
  techStack: string[];

  @Prop()
  repository: string;

  @Prop({ default: true })
  active: boolean;

  @Prop()
  instructions: string;
}

export const ProjectSchema = SchemaFactory.createForClass(Project);
ProjectSchema.index({ active: 1, updatedAt: -1 });
