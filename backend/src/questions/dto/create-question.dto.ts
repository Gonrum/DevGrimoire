import {
  IsString,
  IsOptional,
  IsArray,
  IsMongoId,
  IsNumber,
  Min,
  Max,
  IsIn,
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

  /**
   * Direction of the question. Defaults to 'agent_to_user' (the classic ask_user
   * flow). 'user_to_agent' is a user-initiated follow-up to be answered by an
   * agent (T-247), no timeout, no broadcast notification.
   */
  @IsOptional()
  @IsIn(['agent_to_user', 'user_to_agent'])
  direction?: 'agent_to_user' | 'user_to_agent';

  @IsOptional()
  @IsString()
  agentRunId?: string;

  @IsOptional()
  @IsString()
  agentName?: string;
}
