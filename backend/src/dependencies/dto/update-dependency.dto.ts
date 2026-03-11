import { IsString, IsOptional, IsBoolean, IsArray, IsEnum } from 'class-validator';
import { PackageManager } from '../schemas/dependency.schema';

export class UpdateDependencyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(PackageManager)
  packageManager?: PackageManager;

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
