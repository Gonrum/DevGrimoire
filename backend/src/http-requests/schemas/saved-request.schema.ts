import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum HttpRequestMethod {
  GET = 'GET', POST = 'POST', PUT = 'PUT', PATCH = 'PATCH',
  DELETE = 'DELETE', HEAD = 'HEAD', OPTIONS = 'OPTIONS',
}
export enum RequestAuthType { NONE = 'none', BASIC = 'basic', BEARER = 'bearer' }
export enum RequestBodyMode {
  NONE = 'none', RAW = 'raw', FORM_URLENCODED = 'form-urlencoded', MULTIPART = 'multipart',
}

@Schema({ _id: false })
export class RequestKeyValue {
  @Prop({ required: true, trim: true }) key: string;
  @Prop({ default: '' }) value: string;
  @Prop({ default: true }) enabled: boolean;
}
export const RequestKeyValueSchema = SchemaFactory.createForClass(RequestKeyValue);

@Schema({ _id: false })
export class RequestHeaderEntry {
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ default: '' }) value: string;
  @Prop({ default: true }) enabled: boolean;
}
export const RequestHeaderEntrySchema = SchemaFactory.createForClass(RequestHeaderEntry);

@Schema({ _id: false })
export class RequestAuthConfig {
  @Prop({ type: String, enum: RequestAuthType, default: RequestAuthType.NONE }) type: RequestAuthType;
  @Prop() username?: string;
  @Prop() password?: string;
  @Prop() token?: string;
}
export const RequestAuthConfigSchema = SchemaFactory.createForClass(RequestAuthConfig);

@Schema({ _id: false })
export class RequestBodyConfig {
  @Prop({ type: String, enum: RequestBodyMode, default: RequestBodyMode.NONE }) mode: RequestBodyMode;
  @Prop({ default: '' }) raw?: string;
  @Prop() contentType?: string;
  @Prop({ type: [RequestKeyValueSchema], default: [] }) formFields?: RequestKeyValue[];
}
export const RequestBodyConfigSchema = SchemaFactory.createForClass(RequestBodyConfig);

export type SavedRequestDocument = HydratedDocument<SavedRequest>;

@Schema({ timestamps: true, collection: 'http_saved_requests' })
export class SavedRequest {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'RequestCollection', required: true, index: true })
  collectionId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ default: 0 })
  order: number;

  @Prop({ type: String, enum: HttpRequestMethod, default: HttpRequestMethod.GET })
  method: HttpRequestMethod;

  @Prop({ required: true, trim: true })
  url: string;

  @Prop({ type: [RequestKeyValueSchema], default: [] })
  queryParams: RequestKeyValue[];

  @Prop({ type: [RequestHeaderEntrySchema], default: [] })
  headers: RequestHeaderEntry[];

  @Prop({ type: RequestAuthConfigSchema, default: () => ({ type: RequestAuthType.NONE }) })
  auth: RequestAuthConfig;

  @Prop({ type: RequestBodyConfigSchema, default: () => ({ mode: RequestBodyMode.NONE }) })
  body: RequestBodyConfig;

  @Prop({ default: 30000, min: 500, max: 120000 })
  timeoutMs: number;

  @Prop({ default: false })
  followRedirects: boolean;
}

export const SavedRequestSchema = SchemaFactory.createForClass(SavedRequest);
SavedRequestSchema.index({ collectionId: 1, order: 1 });
SavedRequestSchema.index({ projectId: 1 });
