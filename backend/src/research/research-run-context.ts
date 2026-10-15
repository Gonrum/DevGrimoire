import type { DepthConfig, StepKind } from './research-config';
import { Interrupted, type ResearchLlmService } from './research-llm.service';
import type { SourceRegistry } from './research-sources';
import type { ResearchWeb } from './research-web';

export interface RunFile { n: number; name: string; text: string; notes: string }

export interface RunContext {
  researchId: string;
  topic: string;
  focus?: string;
  /** Nachfrage beim Vertiefen. */
  question?: string;
  cfg: DepthConfig;
  registry: SourceRegistry;
  files: RunFile[];
  signal: AbortSignal;
  llm: Pick<ResearchLlmService, 'call'>;
  web: Pick<ResearchWeb, 'search' | 'fetch'>;
  /** Klein geschrieben, getrimmt. */
  usedQueries: Set<string>;
  models: Set<string>;
  /** Fire-and-forget. */
  step(kind: StepKind, text: string, lane?: string): void;
  onReroute(lane: string): (to: string) => void;
}

export function throwIfAborted(ctx: RunContext): void {
  if (ctx.signal.aborted) throw new Interrupted('Recherche unterbrochen');
}
