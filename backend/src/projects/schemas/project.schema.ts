import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { GitRepositorySchema, GitRepository } from '../../commits/schemas/git-repository.schema';

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

  @Prop({ type: [String], default: [] })
  tags: string[];

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

  @Prop({ default: '{type}-{n}' })
  todoNumberFormat: string;

  @Prop({ default: '{type}-{n}' })
  milestoneNumberFormat: string;

  @Prop({ type: [GitRepositorySchema], default: [] })
  gitRepositories: GitRepository[];

  /**
   * Replication opt-in per project. When `enabled: true`, this project's
   * changes are pushed to / accepted from configured peer/slave. Default is
   * implicit (undefined = not replicated) so adding the feature doesn't
   * suddenly leak data from existing installations.
   */
  @Prop({
    type: {
      enabled: { type: Boolean, default: false },
      _id: false,
    },
    default: undefined,
  })
  replicationConfig?: { enabled: boolean };
}

export const ProjectSchema = SchemaFactory.createForClass(Project);
ProjectSchema.index({ active: 1, updatedAt: -1 });
