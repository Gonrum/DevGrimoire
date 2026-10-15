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

export interface ResearchLlmResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  /** "Modell @ Endpunkt-Host" */
  model: string;
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

  /** Wartet auf einen freien Slot; Abbruch → Interrupted, Frist → Error. */
  private async lease(c: ResearchLlmCall, exclude: Set<string>): Promise<Slot> {
    const deadline = Date.now() + LIMITS[c.kind].timeoutMs;
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
      const now = Date.now();
      if (now >= deadline) throw new Error('kein Endpunkt frei');
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
    const limits = LIMITS[c.kind];
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

    let text = '';
    const toolCalls: ResearchLlmResult['toolCalls'] = [];
    for await (const ev of iter) {
      if (ev.type === 'content') {
        text += ev.delta;
        this.live.emit(c.researchId, { type: 'delta', lane: c.lane, kind: 'content', text: ev.delta });
      } else if (ev.type === 'reasoning') {
        this.live.emit(c.researchId, { type: 'delta', lane: c.lane, kind: 'reasoning', text: ev.delta });
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      }
    }
    return { text, toolCalls };
  }
}
