import { IsString, IsOptional, IsArray, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ProjectComponentDto } from './project-component.dto';

export class CreateProjectDto {
  @IsString()
  name: string;

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
}
