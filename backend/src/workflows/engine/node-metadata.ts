import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

export type NodeBranch = 'success' | 'failure' | 'custom';

export interface NodeMetadata {
  type: string;
  category: 'trigger' | 'action' | 'control' | 'agent';
  label: string;
  description: string;
  allowedScopes: WorkflowScope[];
  configSchema: z.ZodTypeAny;
  outputs: Record<string, string>;
  branches?: NodeBranch[];
}

export interface NodeMetadataPublic {
  type: string;
  category: NodeMetadata['category'];
  label: string;
  description: string;
  allowedScopes: WorkflowScope[];
  configJsonSchema: unknown;
  outputs: Record<string, string>;
  branches: NodeBranch[];
}

export function toPublicMetadata(meta: NodeMetadata): NodeMetadataPublic {
  return {
    type: meta.type,
    category: meta.category,
    label: meta.label,
    description: meta.description,
    allowedScopes: meta.allowedScopes,
    configJsonSchema: zodToJsonSchema(meta.configSchema as any, { name: meta.type }),
    outputs: meta.outputs,
    branches: meta.branches ?? ['success', 'failure'],
  };
}
