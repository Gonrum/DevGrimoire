import { WorkflowRunStatus } from '../schemas/workflow-run.schema';
import { WorkflowNodeRunStatus } from '../schemas/workflow-node-run.schema';

/** Ein Run in einem dieser Zustände wird von niemandem mehr verändert (M-20). */
export const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  WorkflowRunStatus.SUCCEEDED,
  WorkflowRunStatus.FAILED,
  WorkflowRunStatus.CANCELLED,
];

/** NodeRuns, die noch etwas tun oder auf etwas warten. */
export const OPEN_NODE_RUN_STATUSES: readonly WorkflowNodeRunStatus[] = [
  WorkflowNodeRunStatus.QUEUED,
  WorkflowNodeRunStatus.RUNNING,
  WorkflowNodeRunStatus.WAITING,
  WorkflowNodeRunStatus.RETRYING,
];

/** Payload `{ runId: string }` — die Engine räumt Queue und laufende Executoren ab. */
export const WORKFLOW_RUN_CANCELLED = 'workflow.run.cancelled';
