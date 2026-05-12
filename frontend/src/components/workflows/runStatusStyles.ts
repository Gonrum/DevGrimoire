import { WorkflowNodeRunStatus } from '../../api/workflows';

interface StatusStyle {
  ring: string;
  dotBg: string;
  label: string;
}

const idle: StatusStyle = { ring: '', dotBg: 'bg-gray-500', label: 'Idle' };

export const runStatusStyles: Record<WorkflowNodeRunStatus | 'idle', StatusStyle> = {
  idle,
  queued: { ring: 'ring-2 ring-gray-400', dotBg: 'bg-gray-400', label: 'Queued' },
  running: { ring: 'ring-2 ring-yellow-400 animate-pulse', dotBg: 'bg-yellow-400 animate-pulse', label: 'Running' },
  waiting: { ring: 'ring-2 ring-violet-400 animate-pulse', dotBg: 'bg-violet-400 animate-pulse', label: 'Waiting' },
  succeeded: { ring: 'ring-2 ring-green-500', dotBg: 'bg-green-500', label: 'Succeeded' },
  failed: { ring: 'ring-2 ring-red-500', dotBg: 'bg-red-500', label: 'Failed' },
  skipped: { ring: 'ring-2 ring-gray-600', dotBg: 'bg-gray-600', label: 'Skipped' },
  retrying: { ring: 'ring-2 ring-amber-400 animate-pulse', dotBg: 'bg-amber-400', label: 'Retrying' },
  interrupted: { ring: 'ring-2 ring-amber-500', dotBg: 'bg-amber-500', label: 'Interrupted' },
};
