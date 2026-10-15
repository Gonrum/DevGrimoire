import { Injectable } from '@nestjs/common';
import { EndpointAllocator } from '../balancer/endpoint-allocator.service';
import { LlmEndpointsService } from '../balancer/llm-endpoints.service';
import { LlmHealthService } from '../balancer/llm-health.service';
import { LlmClient, ChatToolCallOpts } from '../balancer/llm-client.service';
import type { Slot } from '../balancer/balancer.types';
import type { OpenAiToolDef, LlmMessageWithTools } from '../chat/chat-llm.service';
import { ResearchLiveService } from './research-live.service';
import { LIMITS, type LimitKind } from './research-config';

export class Interrupted extends Error {
  override name = 'Interrupted';
}

export { LIMITS } from './research-config';
export type { LimitKind } from './research-config';

export interface ResearchLlmCall {
  researchId: string;
  lane: string;
  kind: LimitKind;
  /** Inkl. system als erste Nachricht. */
  messages: LlmMessageWithTools[];
  tools?: OpenAiToolDef[];
  signal: AbortSignal;
  /** Umleitung: wird NACH erfolgreicher Zuteilung des nächsten Slots mit dem Label des NEUEN Endpunkts aufgerufen. */
  onReroute?: (to: string) => void;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface ResearchLlmResult {
  /** Antworttext ohne `<think>`-Blöcke. */
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  /** "Modell @ Endpunkt-Host" */
  model: string;
  /** Warum der Strom endete; fehlt, wenn der Anbieter keinen Grund meldet. */
  finishReason?: FinishReason;
}

export const TOKEN_BUDGET_EXHAUSTED = 'Token-Budget des Modells erschöpft';
const NEAR_EMPTY = 20;

/**
 * Hat das Modell sein Token-Budget aufgebraucht, ohne verwertbare Antwort?
 * Typisch für Reasoning-Modelle, die das ganze Budget in `<think>` verbrauchen.
 */
export function budgetExhausted(res: Pick<ResearchLlmResult, 'text' | 'toolCalls' | 'finishReason'>): boolean {
  return res.finishReason === 'length' && res.toolCalls.length === 0 && res.text.trim().length < NEAR_EMPTY;
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * Trennt Reasoning (`<think>…</think>`) vom Antworttext. Ein nie geschlossenes
 * `<think>` macht den Rest zu Reasoning; ein `</think>` ohne Öffnung (Vorlagen,
 * die das öffnende Tag selbst setzen) macht alles davor zu Reasoning.
 */
export function splitThink(raw: string): { text: string; reasoning: string } {
  const reasoning: string[] = [];
  let rest = raw;
  const firstClose = rest.indexOf(THINK_CLOSE);
  const firstOpen = rest.indexOf(THINK_OPEN);
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) {
    reasoning.push(rest.slice(0, firstClose));
    rest = rest.slice(firstClose + THINK_CLOSE.length);
  }
  let text = '';
  for (;;) {
    const open = rest.indexOf(THINK_OPEN);
    if (open < 0) { text += rest; break; }
    text += rest.slice(0, open);
    const close = rest.indexOf(THINK_CLOSE, open + THINK_OPEN.length);
    if (close < 0) { reasoning.push(rest.slice(open + THINK_OPEN.length)); break; }
    reasoning.push(rest.slice(open + THINK_OPEN.length, close));
    rest = rest.slice(close + THINK_CLOSE.length);
  }
  if (reasoning.length === 0) return { text: raw, reasoning: '' };
  return { text: text.trim(), reasoning: reasoning.join('\n') };
}

/** Längster Suffix von `s`, der ein echter Präfix von `tag` ist (Tag über Chunk-Grenzen). */
function partialTagSuffix(s: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
    if (tag.startsWith(s.slice(-k))) return k;
  }
  return 0;
}

/** Leitet Inhalts-Deltas live in `content` oder `reasoning`, je nachdem, ob gerade ein `<think>` offen ist. */
class ThinkRouter {
  private buf = '';
  private inThink = false;
  constructor(private readonly emit: (kind: 'content' | 'reasoning', text: string) => void) {}

  feed(delta: string): void {
    this.buf += delta;
    for (;;) {
      const tag = this.inThink ? THINK_CLOSE : THINK_OPEN;
      const at = this.buf.indexOf(tag);
      if (at >= 0) {
        this.out(this.buf.slice(0, at));
        this.buf = this.buf.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      const hold = partialTagSuffix(this.buf, tag);
      this.out(this.buf.slice(0, this.buf.length - hold));
      this.buf = this.buf.slice(this.buf.length - hold);
      return;
    }
  }

  flush(): void {
    this.out(this.buf);
    this.buf = '';
  }

  private out(text: string): void {
    if (text !== '') this.emit(this.inThink ? 'reasoning' : 'content', text);
  }
}

/** `Modell @ Host`; fällt auf die rohe baseUrl zurück, wenn sie keinen Host hergibt. */
function endpointLabel(slot: Slot): string {
  let host: string;
  try { host = new URL(slot.baseUrl).host; } catch { host = ''; }
  return `${slot.model} @ ${host || slot.baseUrl}`;
}

const MAX_REROUTES = 2;
const POLL_MS = 500;
const WAIT_EVENT_MS = 5_000;

/**
 * LLM-Aufrufe der Recherche: ein Slot pro Aufruf (Pool `workflow`), Freigabe
 * genau einmal auf jedem Ausgang, Lane-Bindung an den zuletzt genutzten
 * Endpunkt, Deltas (Text und Reasoning) in die Live-Lane.
 */
@Injectable()
export class ResearchLlmService {
  /** Grenzen je Aufrufart; als Feld, damit Checks kleine Fristen einsetzen können. */
  limits: Record<LimitKind, { maxTokens: number; timeoutMs: number }> = LIMITS;

  constructor(
    private readonly allocator: EndpointAllocator,
    private readonly endpoints: LlmEndpointsService,
    private readonly health: LlmHealthService,
    private readonly client: LlmClient,
    private readonly live: ResearchLiveService,
  ) {}

  async call(c: ResearchLlmCall): Promise<ResearchLlmResult> {
    const exclude = new Set<string>();
    let rerouted = false;
    for (let attempt = 0; ; attempt++) {
      const slot = await this.lease(c, exclude);
      const label = endpointLabel(slot);
      // Ab hier gehört der Slot uns: alles Weitere in try/finally.
      let keyFailed = false;
      try {
        if (rerouted) {
          rerouted = false;
          c.onReroute?.(label);
        }
        let apiKey: string | null;
        try {
          apiKey = await this.endpoints.getDecryptedApiKey(slot.id);
        } catch (err) {
          keyFailed = true; // lokaler Konfigurations-/Krypto-Fehler, nicht der Endpunkt
          throw err;
        }
        this.live.emit(c.researchId, { type: 'call', lane: c.lane, model: label });
        const out = await this.stream(c, slot, apiKey);
        this.health.recordSuccess(slot.id);
        this.live.setSticky(c.researchId, c.lane, slot.id);
        return { ...out, model: label };
      } catch (err) {
        if (c.signal.aborted) throw new Interrupted('abgebrochen');
        if (keyFailed) throw err;
        this.health.recordFailure(slot.id);
        exclude.add(slot.id);
        if (attempt >= MAX_REROUTES) throw err;
        // Kein Ersatz-Endpunkt: sofort den ursprünglichen Fehler, nicht warten.
        if (!(await this.allocator.hasCandidate('workflow', exclude))) throw err;
        rerouted = true;
      } finally {
        this.allocator.release(slot.id);
        this.live.emit(c.researchId, { type: 'idle', lane: c.lane });
      }
    }
  }

  /**
   * Wartet auf einen freien Slot; Abbruch → Interrupted. Solange ein Endpunkt
   * des Pools in Frage kommt, wird ohne Frist gewartet — auf einem einzelnen
   * lokalen Endpunkt hält eine andere Lane den Slot oft länger als die Frist
   * eines Aufrufs, und der wartende Teilauftrag scheiterte sonst grundlos. Die
   * Frist gilt nur dem Strom. Ohne Kandidaten → sofort Error.
   */
  private async lease(c: ResearchLlmCall, exclude: Set<string>): Promise<Slot> {
    let lastWait = 0;
    for (;;) {
      if (c.signal.aborted) throw new Interrupted('abgebrochen');
      const sticky = this.live.sticky(c.researchId, c.lane);
      const prefer = sticky && !exclude.has(sticky) ? sticky : undefined;
      const slot = await this.allocator.acquire('workflow', { prefer, exclude });
      if (slot) {
        // Abbruch zwischen Zuteilung und Rückkehr: Slot nicht verlieren.
        if (c.signal.aborted) {
          this.allocator.release(slot.id);
          throw new Interrupted('abgebrochen');
        }
        return slot;
      }
      if (!(await this.allocator.hasCandidate('workflow', exclude))) throw new Error('kein Endpunkt frei');
      if (c.signal.aborted) throw new Interrupted('abgebrochen');
      const now = Date.now();
      if (now - lastWait >= WAIT_EVENT_MS) {
        lastWait = now;
        this.live.emit(c.researchId, { type: 'wait', lane: c.lane, busy: this.allocator.snapshot() });
      }
      await this.sleep(POLL_MS, c.signal);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
      const t = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async stream(
    c: ResearchLlmCall,
    slot: Slot,
    apiKey: string | null,
  ): Promise<Omit<ResearchLlmResult, 'model'>> {
    const limits = this.limits[c.kind];
    const opts: ChatToolCallOpts = {
      provider: slot.provider,
      baseUrl: slot.baseUrl,
      model: slot.model,
      apiKey,
      messages: c.messages,
      tools: c.tools ?? [],
      temperature: 0.3,
      maxTokens: limits.maxTokens,
      includeReasoning: true,
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(limits.timeoutMs)]),
    };
    const iter = slot.provider === 'anthropic'
      ? this.client.chatStreamAnthropicTools(opts)
      : this.client.chatStreamOpenAiTools(opts);

    let raw = '';
    let finishReason: FinishReason | undefined;
    const toolCalls: ResearchLlmResult['toolCalls'] = [];
    const router = new ThinkRouter((kind, text) => this.live.emit(c.researchId, { type: 'delta', lane: c.lane, kind, text }));
    for await (const ev of iter) {
      if (ev.type === 'content') {
        raw += ev.delta;
        router.feed(ev.delta);
      } else if (ev.type === 'reasoning') {
        this.live.emit(c.researchId, { type: 'delta', lane: c.lane, kind: 'reasoning', text: ev.delta });
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      } else if (ev.type === 'finish') {
        finishReason = ev.reason;
      }
    }
    router.flush();
    const { text } = splitThink(raw);
    return { text, toolCalls, ...(finishReason ? { finishReason } : {}) };
  }
}
