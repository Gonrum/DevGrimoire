import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsMongoId,
} from 'class-validator';
import { TodoStatus, TodoPriority } from '../schemas/todo.schema';

export class CreateTodoDto {
  @IsMongoId()
  projectId: string;

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
}
