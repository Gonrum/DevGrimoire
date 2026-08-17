// `import type` (zur Laufzeit gelöscht) — diese Datei bleibt damit frei von
// einer Abhängigkeit auf das ChatModule und lädt in den .cjs-Checks ohne Nest.
import type { ChatStreamEvent } from '../chat/chat-llm.service';
import { isRecord } from '../common/narrow';

export const BALANCER_QUEUE = 'llm-balancer';

export type LlmPurpose = 'chat' | 'embedding' | 'workflow';
export const LLM_PURPOSES: readonly LlmPurpose[] = ['chat', 'embedding', 'workflow'] as const;

export type LlmProviderKind = 'openai-compatible' | 'anthropic' | 'openai' | 'ollama';
export const LLM_PROVIDER_KINDS: readonly LlmProviderKind[] = [
  'openai-compatible', 'anthropic', 'openai', 'ollama',
] as const;

/**
 * Verengung eines gespeicherten Strings auf einen Provider-Typ — per
 * `find()`, nicht per Assertion: der enge Typ entsteht aus einer echten
 * Laufzeitprüfung.
 *
 * `lmstudio` ist historisch (LM Studio spricht das OpenAI-Protokoll), und alles
 * Unbekannte fällt auf `openai-compatible` zurück. Das ist genau das bisherige
 * Verhalten: `LlmClient` prüft nur auf `anthropic` und behandelt jeden anderen
 * String als OpenAI-kompatibel. Der Fallback macht das sichtbar, statt einen
 * ungeprüften String als `LlmProviderKind` auszugeben.
 */
export function toProviderKind(value: unknown): LlmProviderKind {
  if (value === 'lmstudio') return 'openai-compatible';
  const match = LLM_PROVIDER_KINDS.find((candidate) => candidate === value);
  return match ?? 'openai-compatible';
}

export function isLlmPurpose(value: unknown): value is LlmPurpose {
  return LLM_PURPOSES.some((candidate) => candidate === value);
}

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

/**
 * `usage`-Block einer Anbieter-Antwort. Ohne numerisches `total_tokens` gilt die
 * Antwort als usage-frei (Anthropic zählt in `input_tokens`/`output_tokens` —
 * der Aufrufer liest die dann selbst, siehe `chatNonStream`).
 *
 * Die Einzelfelder werden jetzt auf `number` geprüft statt nur mit `?? 0`
 * durchgereicht: ein Anbieter, der `"prompt_tokens": "17"` schickt, hat sonst
 * einen String in einem als `number` deklarierten Feld — und der landete
 * ungeprüft in der Usage-Statistik.
 */
export function parseUsage(u: unknown): TokenUsage {
  if (!isRecord(u)) return { ...ZERO_USAGE };
  if (typeof u.total_tokens !== 'number') return { ...ZERO_USAGE };
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return {
    promptTokens: count(u.prompt_tokens),
    completionTokens: count(u.completion_tokens),
    totalTokens: u.total_tokens,
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

/** Terminales Ergebnis des atomaren (nicht gestreamten) Embedding-Pfads. */
export interface EmbedRelayResult {
  embedding: number[];
}

/**
 * Relay-Ereignisse zwischen Worker und Gateway.
 *
 * `StreamRelay` ist prozess-intern (ReplaySubject, keine Redis-Runde), die
 * Objekte werden also per Referenz übergeben und **nicht** serialisiert. Genau
 * deshalb stehen hier die echten Typen statt `Record<string, unknown>`: der
 * Kommentar „passthrough of ChatStreamEvent" war vorher nur ein Kommentar, und
 * beide Enden mussten ihn per `as unknown as` behaupten.
 */
export type RelayEvent =
  | { type: 'chat_event'; event: ChatStreamEvent }
  | { type: 'result'; data: EmbedRelayResult; usage: TokenUsage }
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; status: number; message: string }
  | { type: 'cancel' };
