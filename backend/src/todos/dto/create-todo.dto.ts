import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsMongoId,
  ValidateIf,
} from 'class-validator';
import { TodoStatus, TodoPriority } from '../schemas/todo.schema';

export class CreateTodoDto {
  @ValidateIf((o) => !o.customerId)
  @IsMongoId()
  projectId?: string;

  @ValidateIf((o) => !o.projectId)
  @IsMongoId()
  customerId?: string;

  @IsString()
  title: string;

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

  @IsString()
  @IsOptional()
  repoLabel?: string;
}
