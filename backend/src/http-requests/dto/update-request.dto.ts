import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString,
  Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HttpRequestMethod } from '../schemas/saved-request.schema';
import { KeyValueDto, HeaderDto, AuthDto, BodyDto } from './create-request.dto';

export class UpdateRequestDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsInt() @Min(0) order?: number;
  @IsOptional() @IsEnum(HttpRequestMethod) method?: HttpRequestMethod;
  @IsOptional() @IsString() @MaxLength(4096) url?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => KeyValueDto)
  queryParams?: KeyValueDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => HeaderDto)
  headers?: HeaderDto[];

  @IsOptional() @ValidateNested() @Type(() => AuthDto) auth?: AuthDto;
  @IsOptional() @ValidateNested() @Type(() => BodyDto) body?: BodyDto;

  @IsOptional() @IsInt() @Min(500) @Max(120000) timeoutMs?: number;
  @IsOptional() @IsBoolean() followRedirects?: boolean;
}
