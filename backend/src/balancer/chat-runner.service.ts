import { Injectable } from '@nestjs/common';
import { LlmClient, ChatCallOpts, ChatToolCallOpts, ChatMessage } from './llm-client.service';
import { StreamRelay } from './stream-relay.service';
import { Slot, ZERO_USAGE } from './balancer.types';
import type { OpenAiToolDef, LlmMessageWithTools } from '../chat/chat-llm.service';

/**
 * Provider-agnostic payload for a single chat turn, carried on the balancer job.
 * Built by `BalancerGateway.runChat`; consumed here in the worker.
 */
export interface ChatJobPayload {
  withTools: boolean;
  messages: unknown[];
  tools?: OpenAiToolDef[];
  temperature: number;
  maxTokens: number;
  images?: { data: string; mediaType: string }[];
}

/**
 * Runs ONE chat turn on an already-leased pool slot and relays every stream
 * event to the client via `StreamRelay`. Executes NO tools — the chat
 * controller's multi-turn loop runs tools and re-enqueues the next turn. Any
 * upstream error propagates out of `run` so the processor's catch publishes the
 * `error` relay event (mirroring the embed branch).
 */
@Injectable()
export class ChatRunner {
  constructor(
    private readonly client: LlmClient,
    private readonly relay: StreamRelay,
  ) {}

  async run(jobId: string, slot: Slot, apiKey: string | null, payload: ChatJobPayload): Promise<void> {
    // Tracks whether the client has already received at least one chat_event
    // for this turn. Set the moment we publish the first one; the processor
    // reads it off a thrown error to decide whether failover would duplicate
    // output (unsafe once true) or is still safe (connect/first-fetch failed).
    let published = false;
    try {
      if (payload.withTools) {
        const opts: ChatToolCallOpts = {
          provider: slot.provider,
          baseUrl: slot.baseUrl,
          model: slot.model,
          apiKey,
          messages: (payload.messages as LlmMessageWithTools[]) ?? [],
          tools: payload.tools ?? [],
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          images: payload.images,
        };
        const iter = slot.provider === 'anthropic'
          ? this.client.chatStreamAnthropicTools(opts)
          : this.client.chatStreamOpenAiTools(opts);
        for await (const event of iter) {
          if (this.relay.isCancelled(jobId)) break;
          this.relay.publish(jobId, { type: 'chat_event', event: event as unknown as Record<string, unknown> });
          published = true;
        }
      } else {
        const opts: ChatCallOpts = {
          provider: slot.provider,
          baseUrl: slot.baseUrl,
          model: slot.model,
          apiKey,
          messages: (payload.messages as ChatMessage[]) ?? [],
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          images: payload.images,
        };
        for await (const token of this.client.chatStream(opts)) {
          if (this.relay.isCancelled(jobId)) break;
          this.relay.publish(jobId, { type: 'chat_event', event: { type: 'content', delta: token } });
          published = true;
        }
      }
      this.relay.publish(jobId, { type: 'done', usage: { ...ZERO_USAGE } });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      (e as Error & { committed?: boolean }).committed = published;
      throw e;
    }
  }
}
