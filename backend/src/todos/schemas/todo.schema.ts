import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TodoDocument = HydratedDocument<Todo>;

export enum TodoStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  REVIEW = 'review',
  DONE = 'done',
}

export enum TodoPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

@Schema({ _id: false })
export class TodoComment {
  @Prop({ required: true })
  text: string;

  @Prop({ default: 'user' })
  author: string;

  @Prop({ default: () => new Date() })
  createdAt: Date;
}

@Schema({ _id: false })
export class AcceptanceCriterion {
  @Prop({ required: true })
  text: string;

  @Prop({ default: false })
  done: boolean;
}

@Schema({ timestamps: true })
export class Todo {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop()
  description: string;

  @Prop({ enum: TodoStatus, default: TodoStatus.OPEN })
  status: TodoStatus;

  @Prop({ enum: TodoPriority, default: TodoPriority.MEDIUM })
  priority: TodoPriority;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Types.ObjectId, ref: 'Milestone' })
  milestoneId: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Todo' }], default: [] })
  blockedBy: Types.ObjectId[];

  @Prop({ type: [TodoComment], default: [] })
  comments: TodoComment[];

  @Prop()
  repoLabel: string;

  @Prop({ default: false })
  archived: boolean;

  @Prop()
  number: number;

  @Prop()
  displayNumber: string;

  @Prop()
  userStories?: string;

  @Prop({ type: [AcceptanceCriterion], default: [] })
  acceptanceCriteria: AcceptanceCriterion[];

  @Prop()
  outOfScope?: string;

  @Prop()
  edgeCases?: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Question' }], default: [] })
  openQuestions: Types.ObjectId[];
}

export const TodoSchema = SchemaFactory.createForClass(Todo);
TodoSchema.index({ projectId: 1, status: 1, priority: 1, createdAt: -1 });
TodoSchema.index({ customerId: 1, status: 1, priority: 1, createdAt: -1 });
TodoSchema.index(
  { projectId: 1, customerId: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'number' } } },
);
