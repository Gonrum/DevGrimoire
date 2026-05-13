import { IsString, IsOptional, IsArray, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ProjectComponentDto } from './project-component.dto';
import { GitRepositoryDto } from './git-repository.dto';

export class UpdateProjectDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  path?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  techStack?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  repository?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @IsBoolean()
  @IsOptional()
  favorite?: boolean;

  @IsString()
  @IsOptional()
  instructions?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProjectComponentDto)
  @IsOptional()
  components?: ProjectComponentDto[];

  @IsString()
  @IsOptional()
  todoNumberFormat?: string;

  @IsString()
  @IsOptional()
  milestoneNumberFormat?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GitRepositoryDto)
  @IsOptional()
  gitRepositories?: GitRepositoryDto[];
}
