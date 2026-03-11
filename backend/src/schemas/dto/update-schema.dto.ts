import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DbType } from '../schemas/db-schema.schema';
import { SchemaFieldDto, SchemaIndexDto } from './create-schema.dto';

export class UpdateSchemaDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsEnum(DbType)
  @IsOptional()
  dbType?: DbType;

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

  @IsString()
  @IsOptional()
  changeNote?: string;
}
