import { IsString, IsOptional, IsMongoId } from 'class-validator';

export class CreateSoulDto {
  @IsMongoId()
  @IsOptional()
  projectId?: string;

  @IsMongoId()
  @IsOptional()
  customerId?: string;

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
