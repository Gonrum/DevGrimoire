import {
  IsString,
  IsOptional,
  IsArray,
  IsMongoId,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export class CreateQuestionDto {
  @IsString()
  question: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  options?: string[];

  @IsString()
  @IsOptional()
  context?: string;

  @IsMongoId()
  @IsOptional()
  todoId?: string;

  @IsMongoId()
  @IsOptional()
  projectId?: string;

  @IsMongoId()
  @IsOptional()
  targetUserId?: string;

  @IsNumber()
  @Min(10)
  @Max(600)
  @IsOptional()
  timeoutSeconds?: number;
}
