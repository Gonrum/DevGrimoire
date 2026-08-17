/**
 * Leser für Antworten fremder LLM-Anbieter (M-52).
 *
 * Wurzel dieser Datei: `res.json()` und `JSON.parse` liefern `any`, und zwar
 * aus vier Protokollen (LM Studio, Ollama, OpenAI, Anthropic), die sich in
 * ihren Teilmengen unterscheiden. Vorher stand an jeder Lesestelle ein
 * `as { … }` — acht in `llm-client.service.ts`, plus zweimal dieselbe
 * Modell-Liste in `llm-endpoints.service.ts` und `chat/chat-llm.service.ts`.
 *
 * **Jedes Feld ist optional.** Ein pflichtig deklariertes Feld, das ein
 * Anbieter nicht schickt, tauscht ein Lint-Finding gegen einen Laufzeitfehler
 * bei genau diesem Anbieter — und die Teilmengen unterscheiden sich real:
 * Ollama sendet `tool_calls` teils ohne `index`, LM Studio `finish_reason` nur
 * im letzten Chunk, Anthropic `stop_reason` nur im `message_delta`.
 *
 * Die Leser **bauen** ein normalisiertes Objekt statt eines zu behaupten: es
 * landet kein Feld im getypten Wert, das nicht zur Laufzeit geprüft wurde.
 * Deshalb keine Assertion und keine Ausnahme in `eslint.config.mjs`.
 */
import { isRecord, isUnknownArray } from '../common/narrow';

/**
 * SSE-Datenzeile oder Response-Body als Objekt. `undefined` steht für „kein
 * Objekt" — kaputter Chunk, JSON-Array, Skalar oder eine HTML-Fehlerseite eines
 * Reverse Proxy. Die Aufrufer behandeln alle vier gleich (Chunk überspringen).
 */
export function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/**
 * Alles-oder-nichts: ein Vektor mit einem Nicht-Zahl-Element wird komplett
 * verworfen. Einzelne Elemente still zu überspringen würde die Dimension
 * verändern und den Fehler erst in LanceDB sichtbar machen.
 */
function asNumberArray(value: unknown): number[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number') return undefined;
    out.push(entry);
  }
  return out;
}

/** OpenAI-kompatibel: `POST /v1/embeddings` → `{ data: [{ embedding: [...] }] }`. */
export function readEmbeddingVector(json: unknown): number[] | undefined {
  if (!isRecord(json) || !isUnknownArray(json.data)) return undefined;
  const first = json.data[0];
  return isRecord(first) ? asNumberArray(first.embedding) : undefined;
}

/** Ollama: `POST /api/embed` → `{ embeddings: [[...]] }`. */
export function readOllamaEmbeddingVector(json: unknown): number[] | undefined {
  if (!isRecord(json) || !isUnknownArray(json.embeddings)) return undefined;
  return asNumberArray(json.embeddings[0]);
}

/** OpenAI-kompatibel / OpenAI / Anthropic: `GET /v1/models` → `{ data: [{ id }] }`. */
export function readModelIds(json: unknown): string[] {
  if (!isRecord(json) || !isUnknownArray(json.data)) return [];
  return json.data
    .map((entry) => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined))
    .filter((id): id is string => id !== undefined);
}

/** Ollama: `GET /api/tags` → `{ models: [{ name }] }`. */
export function readOllamaModelNames(json: unknown): string[] {
  if (!isRecord(json) || !isUnknownArray(json.models)) return [];
  return json.models
    .map((entry) => (isRecord(entry) && typeof entry.name === 'string' ? entry.name : undefined))
    .filter((name): name is string => name !== undefined);
}

/** Ein Tool-Call-Fragment eines Streaming-Chunks im OpenAI-Protokoll. */
export interface OpenAiToolCallDelta {
  /**
   * Bucket-Schlüssel des Akkumulators. Anbieter, die das Feld weglassen
   * (beobachtet bei Ollama), landen alle in Bucket `0` — genau das Verhalten von
   * vorher, wo `undefined` als Map-Schlüssel diente. `normalizeToolCallArgs`
   * fischt dann den ersten vollständigen JSON-Block aus dem verketteten Puffer.
   */
  index: number;
  id?: string;
  name?: string;
  /** Inkrement des `arguments`-Strings; manche Anbieter senden jedes Mal alles. */
  argumentsFragment?: string;
}

/** Normalisierter erster `choice` eines Streaming-Chunks im OpenAI-Protokoll. */
export interface OpenAiChoiceDelta {
  content?: string;
  toolCalls: OpenAiToolCallDelta[];
  finishReason?: string;
}

export function readOpenAiChoiceDelta(json: unknown): OpenAiChoiceDelta | undefined {
  if (!isRecord(json) || !isUnknownArray(json.choices)) return undefined;
  const choice = json.choices[0];
  if (!isRecord(choice)) return undefined;

  const out: OpenAiChoiceDelta = { toolCalls: [] };
  if (typeof choice.finish_reason === 'string') out.finishReason = choice.finish_reason;

  const delta = isRecord(choice.delta) ? choice.delta : undefined;
  if (!delta) return out;
  if (typeof delta.content === 'string') out.content = delta.content;
  if (!isUnknownArray(delta.tool_calls)) return out;

  for (const raw of delta.tool_calls) {
    if (!isRecord(raw)) continue;
    const fn = isRecord(raw.function) ? raw.function : undefined;
    const tc: OpenAiToolCallDelta = { index: typeof raw.index === 'number' ? raw.index : 0 };
    if (typeof raw.id === 'string') tc.id = raw.id;
    if (fn && typeof fn.name === 'string') tc.name = fn.name;
    if (fn && typeof fn.arguments === 'string') tc.argumentsFragment = fn.arguments;
    out.toolCalls.push(tc);
  }
  return out;
}

/**
 * Normalisierter Anthropic-SSE-Event. Flach, weil kein Ereignistyp mehr als
 * eine Handvoll Felder trägt und jedes davon je nach `type` fehlt:
 * `content_block_start` bringt `blockType`/`blockId`/`blockName`,
 * `content_block_delta` bringt `text` **oder** `partialJson`,
 * `message_delta` bringt `stopReason`.
 */
export interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  blockType?: string;
  blockId?: string;
  blockName?: string;
  deltaType?: string;
  text?: string;
  partialJson?: string;
  stopReason?: string;
}

export function readAnthropicStreamEvent(json: unknown): AnthropicStreamEvent {
  if (!isRecord(json)) return {};
  const out: AnthropicStreamEvent = {};
  if (typeof json.type === 'string') out.type = json.type;
  if (typeof json.index === 'number') out.index = json.index;

  const block = isRecord(json.content_block) ? json.content_block : undefined;
  if (block) {
    if (typeof block.type === 'string') out.blockType = block.type;
    if (typeof block.id === 'string') out.blockId = block.id;
    if (typeof block.name === 'string') out.blockName = block.name;
  }

  const delta = isRecord(json.delta) ? json.delta : undefined;
  if (delta) {
    if (typeof delta.type === 'string') out.deltaType = delta.type;
    if (typeof delta.text === 'string') out.text = delta.text;
    if (typeof delta.partial_json === 'string') out.partialJson = delta.partial_json;
    if (typeof delta.stop_reason === 'string') out.stopReason = delta.stop_reason;
  }
  return out;
}
