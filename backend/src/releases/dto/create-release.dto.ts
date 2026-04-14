import { IsString, IsOptional, IsEnum, IsArray, ValidateNested, IsNumber, IsUrl } from 'class-validator';
import { Type } from 'class-transformer';
import { ReleaseType, ReleasePlatform, ReleaseStatus } from '../schemas/release.schema';

export class ReleaseAssetDto {
  @IsString()
  name: string;

  @IsString()
  url: string;

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsString()
  format?: string;
}

export class CreateReleaseDto {
  @IsString()
  projectId: string;

  @IsString()
  version: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(ReleaseType)
  releaseType?: ReleaseType;

  @IsOptional()
  @IsEnum(ReleasePlatform)
  platform?: ReleasePlatform;

  @IsOptional()
  @IsEnum(ReleaseStatus)
  status?: ReleaseStatus;

  @IsOptional()
  @IsString()
  downloadUrl?: string;

  @IsOptional()
  @IsString()
  gitlabReleaseId?: string;

  @IsOptional()
  @IsString()
  gitlabTagName?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReleaseAssetDto)
  assets?: ReleaseAssetDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  repoLabel?: string;
}
