import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { WorkflowNode, WorkflowScope, WorkflowStatus } from '../schemas/workflow-definition.schema';

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

/**
 * DTO-Knoten → Schema-Knoten.
 *
 * Der Unterschied ist genau `config`/`secretRefs`: im DTO optional, im Schema
 * mit Default. Vorher stand dafür `existing.nodes = dto.nodes as never`, was
 * die Prüfung komplett aushebelte; die Defaults werden hier explizit gesetzt.
 */
export function workflowNodeFromDto(dto: WorkflowNodeDto): WorkflowNode {
  return {
    id: dto.id,
    type: dto.type,
    label: dto.label,
    position: dto.position,
    config: dto.config ?? {},
    secretRefs: dto.secretRefs ?? [],
    inputs: dto.inputs,
    outputs: dto.outputs,
    ui: dto.ui,
  };
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

  /**
   * Aus dem Query-String kommt `"false"` als String — ohne Transform war das
   * truthy und lieferte archivierte Workflows mit aus.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includeArchived?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @Type(() => Number)
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
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @Type(() => Number)
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

  /**
   * Workflow, zu dem der Node gehört. Ist er gesetzt, kommen Scope, Projekt
   * und Kunde aus der gespeicherten Definition — nicht aus dem Request. Ohne
   * ihn läuft ein Agent-Node nicht als Trockenlauf, sondern nur als Prüfung.
   */
  @IsOptional()
  @IsMongoId()
  workflowId?: string;

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

/** Vorschau der eingesetzten Config: wie der Test, aber ohne `scope`, `workflowId` Pflicht. */
export class PreviewWorkflowNodeDto {
  @ValidateNested()
  @Type(() => WorkflowNodeDto)
  node: WorkflowNodeDto;

  @IsMongoId()
  workflowId: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  runContext?: Record<string, unknown>;
}

/**
 * Start eines Debug-Laufs. Der Graph kommt aus dem Editor (auch ungespeichert)
 * und wird zum Snapshot des Laufs; die gespeicherte Definition bleibt unberührt.
 */
export class StartDebugRunDto {
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowNodeDto)
  nodes: WorkflowNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges: WorkflowEdgeDto[];
}

/** Ein Schritt eines Debug-Laufs — immer mit dem aktuellen Editor-Graphen. */
export class DebugStepDto {
  @IsString()
  nodeId: string;

  @IsIn(['execute', 'dry'])
  mode: 'execute' | 'dry';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowNodeDto)
  nodes: WorkflowNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges: WorkflowEdgeDto[];
}
