import { IsString, IsOptional, IsEnum, IsArray, IsMongoId, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TodoStatus, TodoPriority } from '../schemas/todo.schema';
import { AcceptanceCriterionDto } from './create-todo.dto';

export class UpdateTodoDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(TodoStatus)
  @IsOptional()
  status?: TodoStatus;

  @IsEnum(TodoPriority)
  @IsOptional()
  priority?: TodoPriority;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsMongoId()
  @IsOptional()
  milestoneId?: string;

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  blockedBy?: string[];

  @IsBoolean()
  @IsOptional()
  archived?: boolean;

  @IsString()
  @IsOptional()
  repoLabel?: string;

  @IsString()
  @IsOptional()
  userStories?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AcceptanceCriterionDto)
  @IsOptional()
  acceptanceCriteria?: AcceptanceCriterionDto[];

  @IsString()
  @IsOptional()
  outOfScope?: string;

  @IsString()
  @IsOptional()
  edgeCases?: string;

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  openQuestions?: string[];
}
