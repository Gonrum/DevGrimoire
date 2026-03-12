import { IsString, IsOptional } from 'class-validator';

export class UpdateSoulDto {
  @IsString()
  @IsOptional()
  vision?: string;

  @IsString()
  @IsOptional()
  principles?: string;

  @IsString()
  @IsOptional()
  conventions?: string;

  @IsString()
  @IsOptional()
  communication?: string;

  @IsString()
  @IsOptional()
  boundaries?: string;

  @IsString()
  @IsOptional()
  workflow?: string;

  @IsString()
  @IsOptional()
  quality?: string;
}
