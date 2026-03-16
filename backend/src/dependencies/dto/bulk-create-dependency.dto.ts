import { IsString, IsArray, IsEnum, ValidateNested, IsOptional, IsBoolean, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { PackageManager } from '../schemas/dependency.schema';

export class BulkDependencyItemDto {
  @IsString()
  name: string;

  @IsString()
  version: string;

  @IsOptional()
  @IsBoolean()
  devDependency?: boolean;
}

export class BulkCreateDependencyDto {
  @IsString()
  projectId: string;

  @IsEnum(PackageManager)
  packageManager: PackageManager;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkDependencyItemDto)
  dependencies: BulkDependencyItemDto[];
}
