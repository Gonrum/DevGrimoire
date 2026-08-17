import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { WorkflowAgentService } from '../workflow-agent.service';
import { expandConfig } from './template';
import { asString } from '../../common/tool-args';
import { asNumber, asStringArray, errorMessage } from '../workflow-narrow';

@Injectable()
export class AgentTaskExecutor implements NodeExecutor {
  readonly type = 'agent.task';
  readonly metadata: NodeMetadata = {
    type: 'agent.task',
    category: 'agent',
    label: 'Agent-Task',
    description:
      'Ruft den konfigurierten Workflow-Agent-LLM mit Prompt + optionalen MCP-Tools. Allowlist gilt pro Node.',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      prompt: z.string().min(1),
      systemPrompt: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().max(600000).optional(),
      maxToolIterations: z.number().int().positive().max(20).optional(),
    }),
    outputs: {
      response: 'string',
      iterations: 'number',
      toolCalls: 'array',
      tokensIn: 'number|null',
      tokensOut: 'number|null',
      model: 'string',
    },
    branches: ['success', 'failure'],
  };

  constructor(private readonly agent: WorkflowAgentService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    const customerId =
      ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined;
    try {
      const out = await this.agent.run({
        prompt: String(expanded.prompt),
        systemPrompt: asString(expanded.systemPrompt),
        runContext: ctx.runContext,
        allowedTools: asStringArray(expanded.allowedTools) ?? [],
        callerScope: { projectId, customerId },
        timeoutMs: asNumber(expanded.timeoutMs) ?? 60000,
        maxToolIterations: asNumber(expanded.maxToolIterations),
      });
      return {
        status: 'success',
        output: {
          response: out.response,
          iterations: out.iterations,
          toolCalls: out.toolCalls,
          tokensIn: out.tokensIn ?? null,
          tokensOut: out.tokensOut ?? null,
          model: out.model,
        },
      };
    } catch (err: unknown) {
      const msg = errorMessage(err);
      const code =
        msg.startsWith('llm_error_') ? 'llm_error'
        : msg === 'timeout' ? 'timeout'
        : msg === 'no_agent_endpoint' ? 'no_agent_endpoint'
        : msg === 'tool_loop_limit' ? 'tool_loop_limit'
        : 'agent_failed';
      return { status: 'failed', error: { code, message: msg } };
    }
  }
}
