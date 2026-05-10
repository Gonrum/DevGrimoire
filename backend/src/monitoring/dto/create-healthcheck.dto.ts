import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HealthcheckMethod } from '../schemas/healthcheck.schema';

export class HealthcheckHeaderDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsString()
  @MaxLength(2000)
  value: string;
}

export class HealthcheckSecretHeaderDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsMongoId()
  secretId: string;
}

export class CreateHealthcheckDto {
  @IsMongoId()
  customerId: string;

  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  customerProjectId?: string;

  @IsOptional()
  @IsMongoId()
  environmentId?: string;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(HealthcheckMethod)
  method?: HealthcheckMethod;

  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => HealthcheckHeaderDto)
  headers?: HealthcheckHeaderDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HealthcheckSecretHeaderDto)
  secretHeaders?: HealthcheckSecretHeaderDto[];

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentType?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86400)
  intervalSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(120000)
  timeoutMs?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(100, { each: true })
  @Max(599, { each: true })
  expectedStatus?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  expectedContent?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  failureThreshold?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
