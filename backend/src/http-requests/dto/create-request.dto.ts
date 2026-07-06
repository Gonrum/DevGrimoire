import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString,
  Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HttpRequestMethod, RequestAuthType, RequestBodyMode } from '../schemas/saved-request.schema';

export class KeyValueDto {
  @IsString() @MaxLength(500) key: string;
  @IsOptional() @IsString() @MaxLength(20000) value?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class HeaderDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(20000) value?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class AuthDto {
  @IsEnum(RequestAuthType) type: RequestAuthType;
  @IsOptional() @IsString() @MaxLength(500) username?: string;
  @IsOptional() @IsString() @MaxLength(2000) password?: string;
  @IsOptional() @IsString() @MaxLength(4000) token?: string;
}

export class BodyDto {
  @IsEnum(RequestBodyMode) mode: RequestBodyMode;
  @IsOptional() @IsString() @MaxLength(200000) raw?: string;
  @IsOptional() @IsString() @MaxLength(200) contentType?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => KeyValueDto)
  formFields?: KeyValueDto[];
}

export class CreateRequestDto {
  @IsOptional() @IsString() collectionId?: string; // meist aus Route-Param
  @IsOptional() @IsString() projectId?: string;

  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsInt() @Min(0) order?: number;

  @IsOptional() @IsEnum(HttpRequestMethod) method?: HttpRequestMethod;

  @IsString() @MaxLength(4096) url: string;

  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => KeyValueDto)
  queryParams?: KeyValueDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => HeaderDto)
  headers?: HeaderDto[];

  @IsOptional() @ValidateNested() @Type(() => AuthDto)
  auth?: AuthDto;

  @IsOptional() @ValidateNested() @Type(() => BodyDto)
  body?: BodyDto;

  @IsOptional() @IsInt() @Min(500) @Max(120000) timeoutMs?: number;
  @IsOptional() @IsBoolean() followRedirects?: boolean;
}
