import { Injectable, Logger } from '@nestjs/common';
import { LlmProviderKind, TokenUsage, parseUsage } from './balancer.types';
// Type-only imports (erased at compile time) → no runtime dependency on ChatModule.
import type { ChatStreamEvent, OpenAiToolDef, LlmMessageWithTools } from '../chat/chat-llm.service';

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Extract the first complete top-level JSON object from a string via bracket-
 * balanced scanning. Used to salvage streaming tool-call arguments when a
 * provider (Ollama) re-sends the full arguments on every delta chunk instead
 * of OpenAI's incremental protocol. Returns `null` if no balanced object is
 * found. Handles strings and escapes so braces inside quoted values don't
 * confuse the depth counter. (Ported from chat-llm.service.ts.)
 */
function extractFirstJsonObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Normalize a streaming tool-call arguments accumulator to a single valid JSON
 * string, falling back to `"{}"` on total garbage. (Ported from
 * chat-llm.service.ts; transitionally duplicated for the balancer.)
 */
function normalizeToolCallArgs(raw: string | undefined | null): string {
  if (!raw || !raw.trim()) return '{}';
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch {
    /* fall through to bracket scan */
  }
  const first = extractFirstJsonObject(trimmed);
  if (first) {
    try {
      return JSON.stringify(JSON.parse(first));
    } catch {
      /* fall through */
    }
  }
  return '{}';
}

export interface EmbedOpts {
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  text: string;
  timeoutMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Base64-encoded image payload attached to the most recent user message. */
export interface ChatImageInput {
  data: string;
  mediaType: string;
}

export interface ChatCallOpts {
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  images?: ChatImageInput[];
  signal?: AbortSignal;
}

/**
 * Single-turn tool-calling call options. Widens `messages` to the tool-aware
 * shape (allows `role: 'tool'` + `tool_calls`) and carries the tool defs.
 */
export type ChatToolCallOpts = Omit<ChatCallOpts, 'messages'> & {
  tools: OpenAiToolDef[];
  messages: LlmMessageWithTools[];
};

/**
 * Provider-adapter consolidating OpenAI-compatible / Anthropic / Ollama calls
 * for the LLM balancer. `chatStream`/`chatNonStream` bodies are ported
 * (transitionally duplicated) from `chat/chat-llm.service.ts`
 * (`streamOpenAI`/`streamAnthropic`/`buildOpenAiMessages`/`parseSseStream`);
 * `embed` is ported from `rag/rag.service.ts` (`embedWithEndpoint`).
 */
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);

  /** Low-level embedding call against an explicit provider/baseUrl/model (with optional API key). */
  async embed(o: EmbedOpts): Promise<number[]> {
    const timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : parseInt(process.env.RAG_TIMEOUT_MS || '5000', 10);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (o.apiKey) headers['Authorization'] = `Bearer ${o.apiKey}`;

    if (o.provider === 'ollama') {
      const res = await fetch(`${o.baseUrl}/api/embed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: o.model, input: o.text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings[0];
    }

    const res = await fetch(`${o.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: o.model, input: o.text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Embedding API failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  /** Streams plain content deltas — dispatches to the provider-specific implementation. */
  async *chatStream(o: ChatCallOpts): AsyncIterable<string> {
    if (o.provider === 'anthropic') {
      yield* this.streamAnthropic(o);
    } else {
      yield* this.streamOpenAI(o);
    }
  }

  /**
   * Single-turn OpenAI-protocol tool-calling stream. Yields `ChatStreamEvent`s
   * (`content` / `tool_call` / `finish`) for ONE turn and executes NO tools —
   * the caller (chat controller loop) runs tools and re-invokes for the next
   * turn. Ported verbatim from chat-llm.service.ts (`streamOpenAiWithTools`).
   */
  async *chatStreamOpenAiTools(o: ChatToolCallOpts): AsyncIterable<ChatStreamEvent> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;

    // Inject images into the most recent user message without breaking the
    // tool-call protocol message shape for the other turns.
    let outgoingMessages: unknown[] = o.messages;
    if (o.images && o.images.length > 0) {
      const clone = [...o.messages];
      for (let i = clone.length - 1; i >= 0; i--) {
        if (clone[i].role === 'user') {
          const original = clone[i];
          clone[i] = {
            ...original,
            content: [
              { type: 'text', text: original.content },
              ...o.images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
              })),
            ],
          } as unknown as LlmMessageWithTools;
          break;
        }
      }
      outgoingMessages = clone;
    }

    const res = await fetch(`${o.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: o.model,
        messages: outgoingMessages,
        tools: o.tools,
        tool_choice: 'auto',
        temperature: o.temperature,
        max_tokens: o.maxTokens,
        stream: true,
      }),
      signal: o.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI-protocol API failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'other' | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string;
              }>;
            };
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            if (choice.delta?.content) {
              yield { type: 'content', delta: choice.delta.content };
            }
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const existing = toolCallAcc.get(tc.index) ?? { id: '', name: '', arguments: '' };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                toolCallAcc.set(tc.index, existing);
              }
            }
            if (choice.finish_reason) {
              const r = choice.finish_reason;
              finishReason = r === 'stop' || r === 'tool_calls' || r === 'length' ? r : 'other';
            }
          } catch {
            /* malformed chunk */
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }

    const indices = Array.from(toolCallAcc.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const tc = toolCallAcc.get(idx);
      if (tc && tc.id && tc.name) {
        // Providers like Ollama resend the full arguments on each delta chunk
        // instead of streaming deltas, so our accumulator can end up with
        // `{...}{...}`. normalizeToolCallArgs extracts the first balanced
        // JSON object to recover.
        const normalized = normalizeToolCallArgs(tc.arguments);
        if (normalized === '{}' && tc.arguments && tc.arguments.trim() !== '{}') {
          this.logger.debug(
            `tool_call ${tc.name} streaming accumulator unparseable (length=${tc.arguments.length}), falling back to "{}". Raw: ${tc.arguments.slice(0, 200)}`,
          );
        }
        yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: normalized };
      }
    }

    yield { type: 'finish', reason: finishReason ?? 'other' };
  }

  /**
   * Single-turn Anthropic Messages API tool-calling stream. Translates the
   * OpenAI-style conversation to Anthropic's content-block shape, yields
   * `ChatStreamEvent`s for ONE turn and executes NO tools. Ported verbatim from
   * chat-llm.service.ts (`streamAnthropicWithTools`).
   */
  async *chatStreamAnthropicTools(o: ChatToolCallOpts): AsyncIterable<ChatStreamEvent> {
    if (!o.apiKey) throw new Error('Anthropic-Provider benötigt einen API-Key');

    type AnthropicTextBlock = { type: 'text'; text: string };
    type AnthropicImageBlock = {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };
    type AnthropicToolUseBlock = {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
    type AnthropicToolResultBlock = {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };
    type AnthropicContentBlock =
      | AnthropicTextBlock
      | AnthropicImageBlock
      | AnthropicToolUseBlock
      | AnthropicToolResultBlock;
    type AnthropicMessage = {
      role: 'user' | 'assistant';
      content: string | AnthropicContentBlock[];
    };

    // Translate the provider-agnostic (OpenAI-style) conversation to Anthropic's
    // message shape. System messages get hoisted to the top-level `system` field.
    // Consecutive `role: 'tool'` results get merged into a single user turn so
    // Anthropic's strict alternating-role requirement is met.
    const systemParts: string[] = [];
    const body: AnthropicMessage[] = [];

    const flushBufferedToolResults = (buf: AnthropicToolResultBlock[]): void => {
      if (buf.length === 0) return;
      body.push({ role: 'user', content: [...buf] });
      buf.length = 0;
    };

    const toolResultBuffer: AnthropicToolResultBlock[] = [];

    for (const m of o.messages) {
      if (m.role === 'system') {
        flushBufferedToolResults(toolResultBuffer);
        if (m.content) systemParts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        // Group consecutive tool results into one user message.
        if (!m.tool_call_id) continue;
        toolResultBuffer.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content || '',
        });
        continue;
      }
      flushBufferedToolResults(toolResultBuffer);

      if (m.role === 'assistant') {
        const blocks: AnthropicContentBlock[] = [];
        if (m.content && m.content.length > 0) {
          blocks.push({ type: 'text', text: m.content });
        }
        if (m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
              parsedInput = {};
            }
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedInput,
            });
          }
        }
        // Anthropic requires non-empty content. If the assistant turn has neither
        // text nor tool_calls (shouldn't happen in our pipeline), emit empty text.
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
        body.push({ role: 'assistant', content: blocks });
        continue;
      }

      // Plain user message — string content stays string for token efficiency.
      body.push({ role: 'user', content: m.content || '' });
    }
    flushBufferedToolResults(toolResultBuffer);

    // Attach images to the last user message, preserving any tool_result blocks
    // that may already be there.
    if (o.images && o.images.length > 0) {
      for (let i = body.length - 1; i >= 0; i--) {
        if (body[i].role === 'user') {
          const original = body[i].content;
          const existing: AnthropicContentBlock[] = typeof original === 'string'
            ? (original ? [{ type: 'text', text: original }] : [])
            : original;
          const imageBlocks: AnthropicContentBlock[] = o.images.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
          }));
          body[i] = { role: 'user', content: [...existing, ...imageBlocks] };
          break;
        }
      }
    }

    if (body.length === 0) body.push({ role: 'user', content: '' });
    if (body[0].role !== 'user') body.unshift({ role: 'user', content: '' });

    // Translate OpenAI tool defs → Anthropic shape.
    const anthropicTools = o.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    const res = await fetch(`${o.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': o.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: o.model,
        system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
        messages: body,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        max_tokens: o.maxTokens,
        temperature: o.temperature,
        stream: true,
      }),
      signal: o.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API failed (${res.status}): ${text.slice(0, 200)}`);
    }

    // Streaming protocol: per index, content_block_start declares the block type
    // (text or tool_use), then content_block_delta supplies either text_delta or
    // input_json_delta partials. We accumulate tool_use input_json fragments per
    // index and emit a single tool_call event when stop_reason === 'tool_use'.
    const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
    let stopReason: 'stop' | 'tool_calls' | 'length' | 'other' | null = null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as {
              type?: string;
              index?: number;
              content_block?: { type?: string; id?: string; name?: string; input?: unknown };
              delta?: {
                type?: string;
                text?: string;
                partial_json?: string;
                stop_reason?: string;
              };
            };
            switch (parsed.type) {
              case 'content_block_start': {
                if (typeof parsed.index === 'number' && parsed.content_block?.type === 'tool_use') {
                  toolBlocks.set(parsed.index, {
                    id: parsed.content_block.id || '',
                    name: parsed.content_block.name || '',
                    argsJson: '',
                  });
                }
                break;
              }
              case 'content_block_delta': {
                if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                  yield { type: 'content', delta: parsed.delta.text };
                } else if (
                  parsed.delta?.type === 'input_json_delta' &&
                  typeof parsed.index === 'number' &&
                  typeof parsed.delta.partial_json === 'string'
                ) {
                  const existing = toolBlocks.get(parsed.index);
                  if (existing) existing.argsJson += parsed.delta.partial_json;
                }
                break;
              }
              case 'message_delta': {
                const r = parsed.delta?.stop_reason;
                if (r === 'end_turn') stopReason = 'stop';
                else if (r === 'tool_use') stopReason = 'tool_calls';
                else if (r === 'max_tokens') stopReason = 'length';
                else if (r) stopReason = 'other';
                break;
              }
              default:
                /* message_start, message_stop, ping, content_block_stop — ignored */
                break;
            }
          } catch {
            /* malformed chunk */
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }

    // Emit tool_calls in index order with normalized JSON arguments.
    const indices = Array.from(toolBlocks.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const tc = toolBlocks.get(idx);
      if (tc && tc.id && tc.name) {
        // Anthropic streams plain JSON fragments, but normalizing handles edge cases
        // (empty input → "{}", malformed concat) the same way OpenAI does.
        const normalized = normalizeToolCallArgs(tc.argsJson || '{}');
        yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: normalized };
      }
    }

    yield { type: 'finish', reason: stopReason ?? 'other' };
  }

  /**
   * Provider-aware, transport-only non-streaming call (used by Task 13's workflow
   * purpose). The caller builds the provider-specific request `body` (OpenAI
   * messages+tools, or Anthropic messages+system+tools+max_tokens) and parses the
   * response. Anthropic → `/v1/messages` (x-api-key), else → `/v1/chat/completions`
   * (Bearer). `parseUsage` returns zero-usage for Anthropic's
   * `input_tokens`/`output_tokens` shape — the caller reads `json.usage` directly then.
   */
  async chatNonStream(o: {
    provider: LlmProviderKind;
    baseUrl: string;
    apiKey: string | null;
    body: Record<string, unknown>;
  }): Promise<{ json: Record<string, unknown>; usage: TokenUsage }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let url: string;
    if (o.provider === 'anthropic') {
      if (!o.apiKey) throw new Error('Anthropic-Provider benötigt einen API-Key');
      url = `${o.baseUrl}/v1/messages`;
      headers['x-api-key'] = o.apiKey;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
    } else {
      if (o.provider === 'openai' && !o.apiKey) throw new Error('OpenAI-Provider benötigt einen API-Key');
      url = `${o.baseUrl}/v1/chat/completions`;
      if (o.apiKey) headers['authorization'] = `Bearer ${o.apiKey}`;
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(o.body) });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as Record<string, unknown>;
    return { json, usage: parseUsage(json.usage) };
  }

  /**
   * Build an OpenAI-compatible messages array. When images are present, the
   * LAST user message is converted from a plain string to a content array
   * that carries the image_url blocks alongside the text.
   */
  private buildOpenAiMessages(
    messages: ChatMessage[],
    images: ChatImageInput[] | undefined,
  ): Array<ChatMessage | { role: 'user'; content: Array<Record<string, unknown>> }> {
    if (!images || images.length === 0) return messages;
    const out: Array<ChatMessage | { role: 'user'; content: Array<Record<string, unknown>> }> = [];
    let injected = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!injected && m.role === 'user') {
        const parts: Array<Record<string, unknown>> = [
          { type: 'text', text: m.content },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
        ];
        out.unshift({ role: 'user', content: parts });
        injected = true;
      } else {
        out.unshift(m);
      }
    }
    return out;
  }

  private async *streamOpenAI(o: ChatCallOpts): AsyncIterable<string> {
    if (o.provider === 'openai' && !o.apiKey) {
      throw new Error('OpenAI-Provider benötigt einen API-Key');
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
    const res = await fetch(`${o.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: o.model,
        messages: this.buildOpenAiMessages(o.messages, o.images),
        temperature: o.temperature,
        max_tokens: o.maxTokens,
        stream: true,
      }),
      signal: o.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI-protocol API failed (${res.status}): ${text.slice(0, 200)}`);
    }
    yield* this.parseSseStream(res.body, (data) => {
      if (data === '[DONE]') return null;
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        return parsed.choices?.[0]?.delta?.content ?? '';
      } catch {
        return '';
      }
    });
  }

  /**
   * Anthropic Messages API (`/v1/messages`). System messages are extracted from the
   * array and concatenated into the top-level `system` field. SSE events of interest
   * are `content_block_delta` with `delta.type === 'text_delta'`.
   */
  private async *streamAnthropic(o: ChatCallOpts): AsyncIterable<string> {
    if (!o.apiKey) throw new Error('Anthropic-Provider benötigt einen API-Key');

    const systemParts: string[] = [];
    type AnthropicContentBlock =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
    type AnthropicMessage = {
      role: 'user' | 'assistant';
      content: string | AnthropicContentBlock[];
    };
    const body: AnthropicMessage[] = [];
    for (const m of o.messages) {
      if (m.role === 'system') {
        if (m.content) systemParts.push(m.content);
      } else {
        body.push({ role: m.role, content: m.content });
      }
    }
    // Attach images to the last user message as content blocks.
    if (o.images && o.images.length > 0) {
      for (let i = body.length - 1; i >= 0; i--) {
        if (body[i].role === 'user') {
          const original = body[i].content;
          const textBlock: AnthropicContentBlock = {
            type: 'text',
            text: typeof original === 'string' ? original : '',
          };
          const imageBlocks: AnthropicContentBlock[] = o.images.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
          }));
          body[i] = { role: 'user', content: [textBlock, ...imageBlocks] };
          break;
        }
      }
    }
    // Anthropic requires a non-empty messages array with alternating user/assistant,
    // starting with user. The ChatContext pipeline already produces that shape for us;
    // if the first entry is accidentally `assistant`, prepend an empty user turn so the
    // request doesn't 400.
    if (body.length === 0) body.push({ role: 'user', content: '' });
    if (body[0].role !== 'user') body.unshift({ role: 'user', content: '' });

    const res = await fetch(`${o.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': o.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: o.model,
        system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
        messages: body,
        max_tokens: o.maxTokens,
        temperature: o.temperature,
        stream: true,
      }),
      signal: o.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API failed (${res.status}): ${text.slice(0, 200)}`);
    }

    yield* this.parseSseStream(res.body, (data) => {
      try {
        const parsed = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          return parsed.delta.text ?? '';
        }
        // Ignore message_start/stop/ping/message_delta etc. for plain streaming
        return '';
      } catch {
        return '';
      }
    });
  }

  private async *parseSseStream(
    body: ReadableStream<Uint8Array>,
    extract: (data: string) => string | null,
  ): AsyncIterable<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          const text = extract(data);
          if (text === null) return;
          if (text) yield text;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }
}
