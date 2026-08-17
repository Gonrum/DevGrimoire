import { Injectable } from '@nestjs/common';
import { LlmClient, ChatCallOpts, ChatToolCallOpts, ChatImageInput, ChatMessage } from './llm-client.service';
import { StreamRelay } from './stream-relay.service';
import { Slot, ZERO_USAGE } from './balancer.types';
import { errorMessage, isRecord, isUnknownArray } from '../common/narrow';
import type { OpenAiToolDef, LlmMessageWithTools } from '../chat/chat-llm.service';

/**
 * Provider-agnostic payload for a single chat turn, carried on the balancer job.
 * Built by `BalancerGateway.runChat`; consumed here in the worker.
 *
 * `messages` bleibt `unknown[]`: der Job läuft über **Redis**, was hier ankommt
 * ist also wieder rohes JSON, egal wie getypt es eingestellt wurde. Verengt wird
 * es in `readChatJobPayload` und den `read*Messages`-Lesern unten.
 *
 * `temperature`/`maxTokens` sind optional, weil sie im Payload fehlen können —
 * vorher standen sie als `number` deklariert und ein fehlender Wert lief als
 * `undefined` durch. `run` setzt dafür die Defaults unten.
 */
export interface ChatJobPayload {
  withTools: boolean;
  messages: unknown[];
  tools?: OpenAiToolDef[];
  temperature?: number;
  maxTokens?: number;
  images?: ChatImageInput[];
}

/** Nur erreichbar, wenn der Payload nicht von `runChat` stammt (das setzt beide). */
const FALLBACK_TEMPERATURE = 0.7;
const FALLBACK_MAX_TOKENS = 2048;

/**
 * Fehler eines Turns, der bereits Tokens an den Client zugestellt hat.
 *
 * Der Processor entscheidet daran, ob ein Failover auf einen anderen Endpunkt
 * die Ausgabe verdoppeln würde. Die Form stand vorher als eigener Cast auf
 * beiden Seiten (`as Error & { committed?: boolean }` hier,
 * `as { committed?: boolean }` dort) — jetzt einmal hier.
 */
export interface CommittedError extends Error {
  committed?: boolean;
}

export function hasCommittedOutput(err: unknown): boolean {
  return isRecord(err) && err.committed === true;
}

/**
 * Tool-Definitionen aus dem Payload. Ein Eintrag ohne `function`-Block wird
 * verworfen: genau diese Form (`{ type: 'function', function: undefined }`) kam
 * aus einem Lookup-Fehltreffer und ließ die Anthropic-Übersetzung in
 * `t.function.name` sterben.
 *
 * `description` fehlt bei manchen Definitionen; sie wird zu `''` statt das Tool
 * zu verwerfen — der Name ist das, wonach der Dispatcher später sucht.
 */
function readToolDefs(value: unknown): OpenAiToolDef[] {
  if (!isUnknownArray(value)) return [];
  const out: OpenAiToolDef[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.function)) continue;
    const fn = entry.function;
    if (typeof fn.name !== 'string' || fn.name === '') continue;
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters,
      },
    });
  }
  return out;
}

/** Bilder aus dem Payload; ein Eintrag ohne base64-Daten oder MIME-Typ fällt weg. */
function readImages(value: unknown): ChatImageInput[] {
  if (!isUnknownArray(value)) return [];
  const out: ChatImageInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.data !== 'string' || typeof entry.mediaType !== 'string') continue;
    out.push({ data: entry.data, mediaType: entry.mediaType });
  }
  return out;
}

/** Job-Payload → geprüfte Form. Die eine Stelle, an der Redis-JSON getypt wird. */
export function readChatJobPayload(payload: Record<string, unknown>): ChatJobPayload {
  const out: ChatJobPayload = {
    withTools: payload.withTools === true,
    messages: isUnknownArray(payload.messages) ? payload.messages : [],
  };
  const tools = readToolDefs(payload.tools);
  if (tools.length > 0) out.tools = tools;
  if (typeof payload.temperature === 'number') out.temperature = payload.temperature;
  if (typeof payload.maxTokens === 'number') out.maxTokens = payload.maxTokens;
  const images = readImages(payload.images);
  if (images.length > 0) out.images = images;
  return out;
}

const TOOL_MESSAGE_ROLES: readonly LlmMessageWithTools['role'][] = ['system', 'user', 'assistant', 'tool'];
const PLAIN_MESSAGE_ROLES: readonly ChatMessage['role'][] = ['system', 'user', 'assistant'];

/**
 * Nachrichten aus dem Job-Payload, geprüft statt behauptet.
 *
 * Geprüft werden nur `role` (per `find`, also ohne Assertion) und ein
 * String-`content` — die zwei Felder, die jeder Adapter unbedingt liest. Die
 * optionalen Felder (`tool_calls`, `tool_call_id`, `name`) werden per Spread
 * mitgenommen und **nicht** neu gebaut: sie sind je Turn und je Anbieter
 * anders besetzt, und ein selektiver Nachbau hätte genau die Felder verloren,
 * von denen die Anthropic-Übersetzung lebt.
 *
 * Eine formlose Nachricht wird verworfen statt weitergereicht — ein
 * `content: undefined` hätte im Adapter `m.content.length` getroffen.
 */
function readToolMessages(raw: unknown[]): LlmMessageWithTools[] {
  const out: LlmMessageWithTools[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.content !== 'string') continue;
    const role = TOOL_MESSAGE_ROLES.find((candidate) => candidate === entry.role);
    if (role === undefined) continue;
    out.push({ ...entry, role, content: entry.content });
  }
  return out;
}

/** Dasselbe für den werkzeuglosen Pfad, wo `role: 'tool'` nicht vorkommt. */
function readPlainMessages(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.content !== 'string') continue;
    const role = PLAIN_MESSAGE_ROLES.find((candidate) => candidate === entry.role);
    if (role === undefined) continue;
    out.push({ role, content: entry.content });
  }
  return out;
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
          messages: readToolMessages(payload.messages),
          tools: payload.tools ?? [],
          temperature: payload.temperature ?? FALLBACK_TEMPERATURE,
          maxTokens: payload.maxTokens ?? FALLBACK_MAX_TOKENS,
          images: payload.images,
        };
        const iter = slot.provider === 'anthropic'
          ? this.client.chatStreamAnthropicTools(opts)
          : this.client.chatStreamOpenAiTools(opts);
        for await (const event of iter) {
          if (this.relay.isCancelled(jobId)) break;
          this.relay.publish(jobId, { type: 'chat_event', event });
          published = true;
        }
      } else {
        const opts: ChatCallOpts = {
          provider: slot.provider,
          baseUrl: slot.baseUrl,
          model: slot.model,
          apiKey,
          messages: readPlainMessages(payload.messages),
          temperature: payload.temperature ?? FALLBACK_TEMPERATURE,
          maxTokens: payload.maxTokens ?? FALLBACK_MAX_TOKENS,
          images: payload.images,
        };
        for await (const token of this.client.chatStream(opts)) {
          if (this.relay.isCancelled(jobId)) break;
          this.relay.publish(jobId, { type: 'chat_event', event: { type: 'content', delta: token } });
          published = true;
        }
      }
      this.relay.publish(jobId, { type: 'done', usage: { ...ZERO_USAGE } });
    } catch (err: unknown) {
      // `errorMessage` statt `String(err)`: ein geworfenes Objekt wurde vorher
      // zu "[object Object]" — bei abgebrochenen Streams genau der Fall.
      const e: CommittedError = err instanceof Error ? err : new Error(errorMessage(err));
      e.committed = published;
      throw e;
    }
  }
}
