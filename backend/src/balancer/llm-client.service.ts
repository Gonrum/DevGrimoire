import { Injectable } from '@nestjs/common';
import { LlmProviderKind, TokenUsage, parseUsage } from './balancer.types';

const ANTHROPIC_VERSION = '2023-06-01';

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
 * Provider-adapter consolidating OpenAI-compatible / Anthropic / Ollama calls
 * for the LLM balancer. `chatStream`/`chatNonStream` bodies are ported
 * (transitionally duplicated) from `chat/chat-llm.service.ts`
 * (`streamOpenAI`/`streamAnthropic`/`buildOpenAiMessages`/`parseSseStream`);
 * `embed` is ported from `rag/rag.service.ts` (`embedWithEndpoint`).
 */
@Injectable()
export class LlmClient {
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

  /** Non-streaming chat call (used by Task 13's workflow purpose). */
  async chatNonStream(o: ChatCallOpts): Promise<{ json: Record<string, unknown>; usage: TokenUsage }> {
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
        stream: false,
      }),
      signal: o.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI-protocol API failed (${res.status}): ${text.slice(0, 200)}`);
    }
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
