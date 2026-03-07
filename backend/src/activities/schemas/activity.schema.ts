import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ActivityDocument = HydratedDocument<Activity>;

@Schema({ timestamps: true })
export class Activity {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  entity: string;

  @Prop({ required: true })
  action: string;

  @Prop({ type: Types.ObjectId })
  entityId: Types.ObjectId;

  @Prop()
  summary: string;
}

export const ActivitySchema = SchemaFactory.createForClass(Activity);
ActivitySchema.index({ projectId: 1, createdAt: -1 });
