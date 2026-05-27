import {
  IsString,
  IsOptional,
  IsArray,
  IsMongoId,
  IsNumber,
  Min,
  Max,
  IsIn,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EscalationStepDto {
  @IsIn(['user', 'role', 'broadcast'])
  kind: 'user' | 'role' | 'broadcast';

  @IsOptional()
  @IsMongoId()
  userId?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsNumber()
  @Min(10000)
  @Max(60 * 60 * 1000)
  afterMs: number;
}

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
  customerId?: string;

  @IsMongoId()
  @IsOptional()
  researchSessionId?: string;

  @IsMongoId()
  @IsOptional()
  chatSessionId?: string;

  @IsMongoId()
  @IsOptional()
  milestoneId?: string;

  @IsMongoId()
  @IsOptional()
  targetUserId?: string;

  @IsOptional()
  @IsString()
  targetRole?: string;

  @IsOptional()
  @IsBoolean()
  broadcast?: boolean;

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

  /**
   * Optional escalation chain (T-393). Each step re-targets the question and
   * arms a fresh deadline once the previous wait window lapses without an
   * answer. Empty / omitted → no auto-escalation (legacy behaviour).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EscalationStepDto)
  escalationChain?: EscalationStepDto[];
}
