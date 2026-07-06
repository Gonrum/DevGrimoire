import { IsOptional, IsString, IsArray, IsEnum, IsInt, IsBoolean, Max, MaxLength, Min, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { HttpRequestMethod } from '../schemas/saved-request.schema';
import { KeyValueDto, HeaderDto, AuthDto, BodyDto } from './create-request.dto';

// environmentId wählt den Auflösungskontext. Die übrigen Felder erlauben es dem
// Frontend, den aktuellen (noch nicht gespeicherten) Editor-Stand zu senden.
export class SendRequestDto {
  @IsOptional() @IsString() environmentId?: string;

  @IsOptional() @IsEnum(HttpRequestMethod) method?: HttpRequestMethod;
  @IsOptional() @IsString() @MaxLength(4096) url?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => KeyValueDto) queryParams?: KeyValueDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => HeaderDto) headers?: HeaderDto[];
  @IsOptional() @ValidateNested() @Type(() => AuthDto) auth?: AuthDto;
  @IsOptional() @ValidateNested() @Type(() => BodyDto) body?: BodyDto;
  @IsOptional() @IsInt() @Min(500) @Max(120000) timeoutMs?: number;
  @IsOptional() @IsBoolean() followRedirects?: boolean;
}
