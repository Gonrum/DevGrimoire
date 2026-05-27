import {
  IsArray,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WorkflowScope, WorkflowStatus } from '../schemas/workflow-definition.schema';

export class WorkflowNodeDto {
  @IsString()
  id: string;

  @IsString()
  type: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsObject()
  position: { x: number; y: number };

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secretRefs?: string[];

  @IsOptional()
  @IsObject()
  inputs?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  outputs?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown>;
}

export class WorkflowEdgeDto {
  @IsString()
  id: string;

  @IsString()
  source: string;

  @IsString()
  target: string;

  @IsOptional()
  @IsString()
  sourcePort?: string;

  @IsOptional()
  @IsString()
  targetPort?: string;

  @IsOptional()
  @IsEnum(['success', 'failure', 'always', 'custom'])
  branch?: string;

  @IsOptional()
  @IsObject()
  condition?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown>;

  // T-325: per-edge mapping — key=target-side name, value=source-side path.
  @IsOptional()
  @IsObject()
  payloadMapping?: Record<string, string>;
}

export class CreateWorkflowDefinitionDto {
  @IsEnum(WorkflowScope)
  scope: WorkflowScope;

  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowNodeDto)
  nodes?: WorkflowNodeDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges?: WorkflowEdgeDto[];

  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown>;
}

export class UpdateWorkflowDefinitionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(WorkflowStatus)
  status?: WorkflowStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowNodeDto)
  nodes?: WorkflowNodeDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges?: WorkflowEdgeDto[];

  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown>;

  /**
   * If true, this update is treated as runtime-affecting and increments `version`.
   * UI-only patches that don't touch nodes/edges/trigger should keep this false.
   */
  @IsOptional()
  publish?: boolean;
}

export class ListWorkflowDefinitionsDto {
  @IsOptional()
  @IsEnum(WorkflowScope)
  scope?: WorkflowScope;

  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsOptional()
  @IsEnum(WorkflowStatus)
  status?: WorkflowStatus;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  includeArchived?: boolean;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  offset?: number;
}

export class TriggeredByDto {
  @IsEnum(['manual', 'schedule', 'event'])
  type: 'manual' | 'schedule' | 'event';

  @IsOptional()
  @IsString()
  scheduleSlotAt?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}

export class StartWorkflowRunDto {
  @IsMongoId()
  definitionId: string;

  @IsOptional()
  @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => TriggeredByDto)
  triggeredBy?: TriggeredByDto;
}

export class ListWorkflowRunsDto {
  @IsOptional()
  @IsMongoId()
  definitionId?: string;

  @IsOptional()
  @IsEnum(WorkflowScope)
  scope?: WorkflowScope;

  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  offset?: number;
}

export class CancelWorkflowRunDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class RetryWorkflowRunDto {
  @IsOptional()
  @IsString()
  fromNodeId?: string;
}

export class InstantiateWorkflowTemplateDto {
  @IsString()
  templateId: string;

  @IsString()
  name: string;

  @IsEnum(WorkflowScope)
  scope: WorkflowScope;

  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  customerId?: string;
}

export class TestWorkflowNodeDto {
  @ValidateNested()
  @Type(() => WorkflowNodeDto)
  node: WorkflowNodeDto;

  @IsOptional()
  @IsEnum(WorkflowScope)
  scope?: WorkflowScope;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  runContext?: Record<string, unknown>;
}
