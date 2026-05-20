import { IsString, IsOptional, IsEnum, IsIn, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ReleaseType, ReleasePlatform, ReleaseStatus } from '../schemas/release.schema';
import { ReleaseAssetDto } from './create-release.dto';

export class UpdateReleaseDto {
  @IsOptional()
  @IsString()
  version?: string;

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
  @IsIn(['github', 'gitlab', 'gitea'])
  provider?: 'github' | 'gitlab' | 'gitea';

  @IsOptional()
  @IsString()
  providerReleaseId?: string;

  @IsOptional()
  @IsString()
  tagName?: string;

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
