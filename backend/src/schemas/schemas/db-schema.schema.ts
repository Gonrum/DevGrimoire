import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DbSchemaDocument = HydratedDocument<DbSchema>;

export enum DbType {
  MSSQL = 'mssql',
  MYSQL = 'mysql',
  MONGODB = 'mongodb',
  POSTGRESQL = 'postgresql',
}

export interface SchemaField {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
  description?: string;
  isPrimaryKey?: boolean;
  isIndexed?: boolean;
  reference?: string;
}

export interface SchemaIndex {
  name: string;
  fields: string[];
  unique?: boolean;
  type?: string;
}

@Schema({ timestamps: true })
export class DbSchema {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, enum: DbType })
  dbType: DbType;

  @Prop()
  database?: string;

  @Prop()
  description?: string;

  @Prop({ type: [Object], default: [] })
  fields: SchemaField[];

  @Prop({ type: [Object], default: [] })
  indexes: SchemaIndex[];

  @Prop({ default: 1 })
  version: number;

  @Prop({ type: [String], default: [] })
  tags: string[];
}

export const DbSchemaSchema = SchemaFactory.createForClass(DbSchema);
DbSchemaSchema.index({ projectId: 1, name: 1 }, { unique: true });
DbSchemaSchema.index({ projectId: 1, dbType: 1 });
DbSchemaSchema.index({ name: 'text', description: 'text', tags: 'text' });
