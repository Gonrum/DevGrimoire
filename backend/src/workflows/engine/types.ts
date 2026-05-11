import { Types } from 'mongoose';
import { WorkflowNode } from '../schemas/workflow-definition.schema';
import { WorkflowRun } from '../schemas/workflow-run.schema';
import { WorkflowNodeRun } from '../schemas/workflow-node-run.schema';

export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier?: number;
}

export interface ManualTriggerConfig {
  type: 'manual';
}

export interface ScheduleTriggerConfig {
  type: 'schedule';
  cron?: string;
  intervalMinutes?: number;
  timezone?: string;
  maxCatchUp?: number;
}

export type TriggerConfig = ManualTriggerConfig | ScheduleTriggerConfig;

export interface NodeResult {
  status: 'success' | 'failed' | 'waiting';
  output?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
  branch?: 'success' | 'failure' | 'custom';
  waitingFor?: { type: 'question'; refId: Types.ObjectId };
}

export interface NodeLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface NodeExecutionContext {
  run: WorkflowRun & { _id: Types.ObjectId };
  nodeRun: WorkflowNodeRun & { _id: Types.ObjectId };
  node: WorkflowNode;
  config: Record<string, unknown>;
  secretRefs: string[];
  runContext: Record<string, unknown>;
  logger: NodeLogger;
  /** Creates a question record and returns its id. Caller must subsequently
   *  return `{ status: 'waiting', waitingFor: { type: 'question', refId } }`. */
  askUser(question: string, options?: string[]): Promise<{ refId: Types.ObjectId }>;
}

export interface NodeExecutor {
  readonly type: string;
  execute(ctx: NodeExecutionContext): Promise<NodeResult>;
}

export interface NodeJob {
  runId: string;
  nodeRunId: string;
  definitionId: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
}
