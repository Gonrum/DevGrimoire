import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CustomerTemplateItemKind,
  CustomerTemplateType,
} from '../schemas/customer-template.schema';

export class CustomerTemplateItemDto {
  @IsEnum(CustomerTemplateItemKind)
  kind: CustomerTemplateItemKind;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredSecretKeys?: string[];

  @IsOptional()
  @IsObject()
  placeholders?: Record<string, string>;
}

export class CreateCustomerTemplateDto {
  @IsString()
  name: string;

  @IsString()
  slug: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(CustomerTemplateType)
  type: CustomerTemplateType;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerTemplateItemDto)
  items?: CustomerTemplateItemDto[];
}

export class UpdateCustomerTemplateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(CustomerTemplateType)
  type?: CustomerTemplateType;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerTemplateItemDto)
  items?: CustomerTemplateItemDto[];

  /** Force a version bump even when nothing structural changed */
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class ListCustomerTemplatesDto {
  @IsOptional()
  @IsEnum(CustomerTemplateType)
  type?: CustomerTemplateType;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  tag?: string;
}

export class ApplyCustomerTemplateDto {
  @IsMongoId()
  customerId: string;
}
