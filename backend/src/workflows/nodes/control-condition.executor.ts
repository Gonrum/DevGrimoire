import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeBranch, NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { lookupPath } from './template';
import { evalOp, ConditionOp } from './condition-ops';
import { asString, isUnknownArray } from '../../common/tool-args';
import { isRecord } from '../workflow-narrow';

const opSchema = z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'exists', 'truthy']);
const branchSchema = z.enum(['success', 'failure', 'custom']);

// Laufzeitlisten für die Prüfung — aus `.options` der zod-Enums, damit
// Config-Schema und Laufzeitprüfung nicht auseinanderlaufen können.
const CONDITION_OPS: readonly ConditionOp[] = opSchema.options;
const BRANCHES: readonly NodeBranch[] = branchSchema.options;

/** Ein Case der Node-Konfiguration, nachdem er geprüft wurde. */
interface ConditionCase {
  path: string;
  op: ConditionOp;
  value: unknown;
  branch: NodeBranch;
}

/**
 * Liest die `cases` aus der offenen Node-Konfiguration.
 *
 * Vorher stand hier eine Assertion auf die volle Case-Struktur — bei einem
 * Case ohne `when` lief `c.when.path` in einen TypeError, und `op`/`branch`
 * waren als Union nur behauptet. Unvollständige Cases werden jetzt übersprungen
 * (sie hätten ohnehin nie gematcht bzw. den Node zum Absturz gebracht); `op`
 * und `branch` entstehen über `find()` aus einer echten Prüfung.
 */
function readCases(raw: unknown): ConditionCase[] {
  if (!isUnknownArray(raw)) return [];
  const out: ConditionCase[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const when = isRecord(entry.when) ? entry.when : undefined;
    const path = asString(when?.path);
    const op = CONDITION_OPS.find((candidate) => candidate === when?.op);
    const branch = BRANCHES.find((candidate) => candidate === entry.branch);
    if (!path || !op || !branch) continue;
    out.push({ path, op, value: when?.value, branch });
  }
  return out;
}

@Injectable()
export class ControlConditionExecutor implements NodeExecutor {
  readonly type = 'control.condition';
  readonly metadata: NodeMetadata = {
    type: 'control.condition',
    category: 'control',
    label: 'Condition / Switch',
    description: 'Wertet Cases gegen den Run-Context aus und wählt die ausgehende Branch.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      cases: z.array(
        z.object({
          when: z.object({
            path: z.string().min(1),
            op: opSchema,
            value: z.unknown().optional(),
          }),
          branch: branchSchema,
        }),
      ),
      default: branchSchema.optional(),
    }),
    outputs: { matchedCase: 'number|null', matchedPath: 'string|null', lhs: 'unknown' },
    branches: ['success', 'failure', 'custom'],
  };

  // Kein `async`: die Auswertung ist rein synchron.
  execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const cases = readCases(ctx.config.cases);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const lhs = lookupPath(c.path, ctx.runContext);
      if (evalOp(lhs, c.op, c.value)) {
        return Promise.resolve({
          status: 'success',
          output: { matchedCase: i, matchedPath: c.path, lhs },
          branch: c.branch,
        });
      }
    }
    const def = BRANCHES.find((candidate) => candidate === ctx.config.default) ?? 'failure';
    return Promise.resolve({
      status: 'success',
      output: { matchedCase: null, matchedPath: null, lhs: null },
      branch: def,
    });
  }
}
