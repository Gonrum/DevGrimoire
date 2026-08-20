import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** `?follow=true` kommt als String an — Query-Parameter sind immer Strings. */
const toBool = () => Transform(({ value }: { value: unknown }) => value === 'true' || value === true);

/** GET /api/kube-clusters/:id/logs/stream?namespace=&pod=&container=&tailLines=&previous=&follow= */
export class LogsQueryDto {
  @IsString() @MaxLength(253)
  namespace: string;

  @IsString() @MaxLength(253)
  pod: string;

  @IsOptional() @IsString() @MaxLength(253)
  container?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000)
  tailLines?: number;

  @IsOptional() @toBool() @IsBoolean()
  previous?: boolean;

  @IsOptional() @toBool() @IsBoolean()
  follow?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(86400)
  sinceSeconds?: number;
}
