import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

/**
 * `zod-to-json-schema` deklariert seinen Parameter über `zod/v3`, das Projekt
 * baut seine Schemas über `zod` — in zod 3.25 sind das zwei getrennte
 * Deklarationsbäume über **einer** Implementierung. Ein `z.ZodTypeAny` von
 * `zod` ist zu `ZodType` von `zod/v3` deshalb nicht zuweisbar, und der
 * Vergleich sprengt zusätzlich das Instanziierungslimit von TS (TS2589).
 *
 * Vorher stand dafür `zodToJsonSchema(schema as any, …)`, was drei Regeln auf
 * einmal auslöste. Der Aufruf wird stattdessen einmal hier über eine
 * Signatur geführt, die nur behauptet, was zur Laufzeit auch stimmt: es geht
 * ein Zod-Schema hinein und ein JSON-Schema-Objekt heraus. Das ist keine
 * Umgehung der Typprüfung an der Aufrufstelle, sondern ihre einzige Stelle.
 *
 * Ursache liegt außerhalb dieses Moduls: sauber wird das erst, wenn
 * `zod-to-json-schema` und `zod` denselben Deklarationsbaum benutzen.
 */
type SchemaToJsonSchema = (
  schema: unknown,
  options?: { name?: string; $refStrategy?: 'root' | 'relative' | 'none' | 'seen' },
) => object;

const toJsonSchema: SchemaToJsonSchema = zodToJsonSchema;

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
  // $refStrategy: 'none' inlines all schemas so the frontend never has to
  // resolve internal references. Without this, e.g. control.condition's
  // `default` property emits a `$ref` to a deeply nested branch enum, which
  // the renderer can't follow and falls back to a JSON textarea.
  return {
    type: meta.type,
    category: meta.category,
    label: meta.label,
    description: meta.description,
    allowedScopes: meta.allowedScopes,
    configJsonSchema: toJsonSchema(meta.configSchema, {
      name: meta.type,
      $refStrategy: 'none',
    }),
    outputs: meta.outputs,
    branches: meta.branches ?? ['success', 'failure'],
  };
}
