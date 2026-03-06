import { IsString, IsOptional, IsEnum, IsArray } from 'class-validator';
import { TodoStatus, TodoPriority } from '../schemas/todo.schema';

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
}
