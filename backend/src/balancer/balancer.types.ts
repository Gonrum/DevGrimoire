export const BALANCER_QUEUE = 'llm-balancer';

export type LlmPurpose = 'chat' | 'embedding' | 'workflow';
export const LLM_PURPOSES: readonly LlmPurpose[] = ['chat', 'embedding', 'workflow'] as const;

export type LlmProviderKind = 'openai-compatible' | 'anthropic' | 'openai' | 'ollama';
export const LLM_PROVIDER_KINDS: readonly LlmProviderKind[] = [
  'openai-compatible', 'anthropic', 'openai', 'ollama',
] as const;

/** Queue priority per purpose — lower number = higher priority (BullMQ semantics). */
export const PURPOSE_PRIORITY: Record<LlmPurpose, number> = {
  chat: 1,
  workflow: 2,
  embedding: 3,
};

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export function parseUsage(u: unknown): TokenUsage {
  const o = (u ?? {}) as Record<string, number>;
  if (typeof o.total_tokens !== 'number') return { ...ZERO_USAGE };
  return {
    promptTokens: o.prompt_tokens ?? 0,
    completionTokens: o.completion_tokens ?? 0,
    totalTokens: o.total_tokens ?? 0,
  };
}

/** A resolved, connectable endpoint from the registry (no secret — key fetched by id). */
export interface PoolEndpoint {
  id: string;
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  concurrency: number;
  timeoutMs: number;
  visionCapable: boolean;
}

/** A leased slot handed to the worker. */
export interface Slot {
  id: string;
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface GatewayJobData {
  purpose: LlmPurpose;
  stream: boolean;
  /** Provider-agnostic request payload (messages/options/text/tools). */
  payload: Record<string, unknown>;
  /** Optional vision requirement (chat). */
  requireVision?: boolean;
}

export type RelayEvent =
  | { type: 'chat_event'; event: Record<string, unknown> } // passthrough of ChatStreamEvent
  | { type: 'result'; data: Record<string, unknown>; usage: TokenUsage }
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; status: number; message: string }
  | { type: 'cancel' };
