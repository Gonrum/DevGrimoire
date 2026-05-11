import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import {
  UpdateWorkflowAgentConfigDto,
  WorkflowAgentConfigPublic,
  WorkflowAgentProvider,
} from './dto/workflow-agent.dto';
import { ChatToolsService, ALL_TOOL_NAMES, TOOL_DEFINITIONS } from '../chat/chat-tools';

const SETTING_KEY = 'workflow_agent_endpoint_v1';

interface StoredEndpoint {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  apiKeyEncrypted?: string;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

export interface WorkflowAgentEndpoint {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  apiKey?: string;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

@Injectable()
export class WorkflowAgentService {
  private readonly logger = new Logger(WorkflowAgentService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
    private readonly chatTools: ChatToolsService,
  ) {}

  async getConfig(): Promise<WorkflowAgentConfigPublic | null> {
    const raw = await this.settings.get(SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEndpoint;
    return {
      provider: parsed.provider,
      url: parsed.url,
      model: parsed.model,
      hasApiKey: !!parsed.apiKeyEncrypted && parsed.apiKeyEncrypted.length > 0,
      toolsEnabled: parsed.toolsEnabled,
      maxToolIterations: parsed.maxToolIterations,
    };
  }

  async setConfig(dto: UpdateWorkflowAgentConfigDto): Promise<void> {
    const previous = await this.loadEndpoint();
    let apiKeyEncrypted: string | undefined;
    if (dto.apiKey === undefined) {
      apiKeyEncrypted = previous?.apiKey ? this.encryption.encrypt(previous.apiKey) : undefined;
    } else if (dto.apiKey === '') {
      apiKeyEncrypted = undefined;
    } else {
      apiKeyEncrypted = this.encryption.encrypt(dto.apiKey);
    }
    const stored: StoredEndpoint = {
      provider: dto.provider,
      url: dto.url,
      model: dto.model,
      apiKeyEncrypted,
      toolsEnabled: dto.toolsEnabled,
      maxToolIterations: dto.maxToolIterations,
    };
    await this.settings.set(SETTING_KEY, JSON.stringify(stored));
  }

  async loadEndpoint(): Promise<WorkflowAgentEndpoint | null> {
    const raw = await this.settings.get(SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEndpoint;
    return {
      provider: parsed.provider,
      url: parsed.url,
      model: parsed.model,
      apiKey: parsed.apiKeyEncrypted ? this.encryption.decrypt(parsed.apiKeyEncrypted) : undefined,
      toolsEnabled: parsed.toolsEnabled,
      maxToolIterations: parsed.maxToolIterations,
    };
  }

  private effectiveAllowlist(nodeAllowlist: string[]): string[] {
    const envCsv = process.env.WORKFLOW_AGENT_TOOL_ALLOWLIST ?? '';
    const envExplicit = new Set(envCsv.split(',').map((s) => s.trim()).filter(Boolean));
    const suffixOk = (name: string) => /_(get|list|search)$/.test(name);
    const globalAllowed = new Set(
      ALL_TOOL_NAMES.filter((name) => envExplicit.has(name) || suffixOk(name)),
    );
    return nodeAllowlist.filter((name) => globalAllowed.has(name));
  }

  async run(input: {
    prompt: string;
    systemPrompt?: string;
    runContext: Record<string, unknown>;
    allowedTools: string[];
    callerScope: { projectId?: string; customerId?: string };
    timeoutMs: number;
    maxToolIterations?: number;
  }): Promise<{
    response: string;
    iterations: number;
    toolCalls: Array<{ tool: string; args: unknown; result: unknown }>;
    tokensIn?: number;
    tokensOut?: number;
    model: string;
  }> {
    const endpoint = await this.loadEndpoint();
    if (!endpoint) throw new Error('no_agent_endpoint');

    const allowlist = endpoint.toolsEnabled ? this.effectiveAllowlist(input.allowedTools) : [];
    const maxIter = input.maxToolIterations ?? endpoint.maxToolIterations;

    if (endpoint.provider === 'anthropic') {
      return this.runAnthropic(endpoint, input, allowlist, maxIter);
    }
    return this.runOpenAI(endpoint, input, allowlist, maxIter);
  }

  private async runOpenAI(
    endpoint: WorkflowAgentEndpoint,
    input: Parameters<WorkflowAgentService['run']>[0],
    allowlist: string[],
    maxIter: number,
  ): Promise<Awaited<ReturnType<WorkflowAgentService['run']>>> {
    const messages: Array<Record<string, unknown>> = [];
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });

    const toolsForLlm = allowlist
      .filter((name) => TOOL_DEFINITIONS[name])
      .map((name) => ({ type: 'function' as const, function: TOOL_DEFINITIONS[name] }));

    const toolCalls: Array<{ tool: string; args: unknown; result: unknown }> = [];
    let totalIn = 0;
    let totalOut = 0;
    const deadline = Date.now() + input.timeoutMs;

    for (let iter = 0; iter < maxIter; iter++) {
      if (Date.now() > deadline) throw new Error('timeout');

      const body: Record<string, unknown> = {
        model: endpoint.model,
        messages,
        stream: false,
      };
      if (toolsForLlm.length > 0) body.tools = toolsForLlm;

      const url = endpoint.url.replace(/\/$/, '') + '/v1/chat/completions';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`llm_error_${res.status}: ${await res.text().catch(() => '')}`);
      const json = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name: string; arguments: string } }> };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0]?.message;
      if (json.usage?.prompt_tokens) totalIn += json.usage.prompt_tokens;
      if (json.usage?.completion_tokens) totalOut += json.usage.completion_tokens;

      if (!choice) throw new Error('llm_error_no_choice');

      const tcs = choice.tool_calls ?? [];
      if (tcs.length === 0) {
        return {
          response: choice.content ?? '',
          iterations: iter + 1,
          toolCalls,
          tokensIn: totalIn || undefined,
          tokensOut: totalOut || undefined,
          model: endpoint.model,
        };
      }

      messages.push({
        role: 'assistant',
        content: choice.content ?? null,
        tool_calls: tcs,
      });

      for (const tc of tcs) {
        const name = tc.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        if (!allowlist.includes(name)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id ?? name,
            content: JSON.stringify({ success: false, error: `tool "${name}" not in allowlist` }),
          });
          toolCalls.push({ tool: name, args, result: { error: 'not_in_allowlist' } });
          continue;
        }
        const result = await this.chatTools.execute(
          name,
          args,
          { projectId: input.callerScope.projectId ?? null },
          allowlist,
        );
        toolCalls.push({ tool: name, args, result });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id ?? name,
          content: JSON.stringify(result),
        });
      }
    }
    throw new Error('tool_loop_limit');
  }

  private async runAnthropic(
    endpoint: WorkflowAgentEndpoint,
    input: Parameters<WorkflowAgentService['run']>[0],
    allowlist: string[],
    maxIter: number,
  ): Promise<Awaited<ReturnType<WorkflowAgentService['run']>>> {
    type AnthMsg = { role: 'user' | 'assistant'; content: unknown };
    const messages: AnthMsg[] = [{ role: 'user', content: input.prompt }];
    const tools = allowlist
      .filter((name) => TOOL_DEFINITIONS[name])
      .map((name) => ({
        name,
        description: TOOL_DEFINITIONS[name].description,
        input_schema: TOOL_DEFINITIONS[name].parameters,
      }));

    const toolCalls: Array<{ tool: string; args: unknown; result: unknown }> = [];
    let totalIn = 0;
    let totalOut = 0;
    const deadline = Date.now() + input.timeoutMs;

    for (let iter = 0; iter < maxIter; iter++) {
      if (Date.now() > deadline) throw new Error('timeout');

      const body: Record<string, unknown> = {
        model: endpoint.model,
        max_tokens: 4096,
        messages,
      };
      if (input.systemPrompt) body.system = input.systemPrompt;
      if (tools.length > 0) body.tools = tools;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (endpoint.apiKey) headers['x-api-key'] = endpoint.apiKey;

      const res = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`llm_error_${res.status}: ${await res.text().catch(() => '')}`);
      const json = (await res.json()) as {
        content?: Array<{ type: 'text' | 'tool_use'; text?: string; id?: string; name?: string; input?: unknown }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      if (json.usage?.input_tokens) totalIn += json.usage.input_tokens;
      if (json.usage?.output_tokens) totalOut += json.usage.output_tokens;

      const blocks = json.content ?? [];
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');

      if (toolUses.length === 0) {
        return {
          response: textParts,
          iterations: iter + 1,
          toolCalls,
          tokensIn: totalIn || undefined,
          tokensOut: totalOut || undefined,
          model: endpoint.model,
        };
      }

      messages.push({ role: 'assistant', content: blocks });
      const userContent: unknown[] = [];
      for (const tu of toolUses) {
        const name = tu.name ?? '';
        const args = (tu.input as Record<string, unknown>) ?? {};
        let result: unknown;
        if (!allowlist.includes(name)) {
          result = { success: false, error: `tool "${name}" not in allowlist` };
        } else {
          result = await this.chatTools.execute(
            name,
            args,
            { projectId: input.callerScope.projectId ?? null },
            allowlist,
          );
        }
        toolCalls.push({ tool: name, args, result });
        userContent.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: userContent });
    }
    throw new Error('tool_loop_limit');
  }
}
