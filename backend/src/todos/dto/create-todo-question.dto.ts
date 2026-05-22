import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export class CreateTodoQuestionDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  options?: string[];

  @IsString()
  @IsOptional()
  context?: string;

  @IsNumber()
  @Min(10)
  @Max(600)
  @IsOptional()
  timeoutSeconds?: number;

  @IsString()
  @IsOptional()
  agentName?: string;

  @IsString()
  @IsOptional()
  agentRunId?: string;
}
