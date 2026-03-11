import {
  IsString,
  IsOptional,
  IsArray,
  IsMongoId,
  IsEnum,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DbType } from '../schemas/db-schema.schema';

export class SchemaFieldDto {
  @IsString()
  name: string;

  @IsString()
  type: string;

  @IsBoolean()
  @IsOptional()
  nullable?: boolean;

  @IsString()
  @IsOptional()
  defaultValue?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isPrimaryKey?: boolean;

  @IsBoolean()
  @IsOptional()
  isIndexed?: boolean;

  @IsString()
  @IsOptional()
  reference?: string;
}

export class SchemaIndexDto {
  @IsString()
  name: string;

  @IsArray()
  @IsString({ each: true })
  fields: string[];

  @IsBoolean()
  @IsOptional()
  unique?: boolean;

  @IsString()
  @IsOptional()
  type?: string;
}

export class CreateSchemaDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  name: string;

  @IsEnum(DbType)
  dbType: DbType;

  @IsString()
  @IsOptional()
  database?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SchemaFieldDto)
  @IsOptional()
  fields?: SchemaFieldDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SchemaIndexDto)
  @IsOptional()
  indexes?: SchemaIndexDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
