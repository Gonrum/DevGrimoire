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

@Schema({ timestamps: true })
export class Todo {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

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

  @Prop({ default: false })
  archived: boolean;
}

export const TodoSchema = SchemaFactory.createForClass(Todo);
TodoSchema.index({ projectId: 1, status: 1, priority: 1, createdAt: -1 });
