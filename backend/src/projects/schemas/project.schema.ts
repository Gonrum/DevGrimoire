import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export class ProjectComponent {
  name: string;
  version: string;
  path?: string;
}

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

  @Prop({ default: false })
  favorite: boolean;

  @Prop()
  instructions: string;

  @Prop({ type: [{ name: String, version: String, path: String }], default: [] })
  components: ProjectComponent[];
}

export const ProjectSchema = SchemaFactory.createForClass(Project);
ProjectSchema.index({ active: 1, updatedAt: -1 });
