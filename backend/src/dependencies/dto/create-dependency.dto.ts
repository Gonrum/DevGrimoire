import { IsString, IsOptional, IsBoolean, IsArray, IsEnum } from 'class-validator';
import { PackageManager } from '../schemas/dependency.schema';

export class CreateDependencyDto {
  @IsString()
  projectId: string;

  @IsString()
  name: string;

  @IsString()
  version: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(PackageManager)
  packageManager: PackageManager;

  @IsOptional()
  @IsBoolean()
  devDependency?: boolean;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
