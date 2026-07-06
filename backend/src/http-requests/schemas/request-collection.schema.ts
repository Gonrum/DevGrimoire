import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RequestCollectionDocument = HydratedDocument<RequestCollection>;

@Schema({ timestamps: true, collection: 'http_request_collections' })
export class RequestCollection {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ default: 0 })
  order: number;
}

export const RequestCollectionSchema = SchemaFactory.createForClass(RequestCollection);
RequestCollectionSchema.index({ projectId: 1, order: 1 });
