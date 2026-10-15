import { Injectable } from '@nestjs/common';

/** Zeichen, die je Lane im Puffer bleiben (Snapshot für spät hinzukommende Zuschauer). */
const LANE_BUFFER = 30_000;

export type LiveEvent =
  | { type: 'snapshot'; lanes: Record<string, { text: string; reasoning: string; model?: string; active: boolean }> }
  | { type: 'call'; lane: string; model: string }
  | { type: 'wait'; lane: string; busy: Record<string, number> }
  | { type: 'delta'; lane: string; kind: 'content' | 'reasoning'; text: string }
  | { type: 'idle'; lane: string }
  | { type: 'end' };

interface Lane { text: string; reasoning: string; model?: string; active: boolean }

interface Run {
  lanes: Map<string, Lane>;
  subs: Set<(ev: LiveEvent) => void>;
  controller?: AbortController;
  sticky: Map<string, string>;
  cleanup?: NodeJS.Timeout;
}

/**
 * Live-Lanes laufender Recherchen — reiner Prozessspeicher, keine DB.
 * Hält je Lauf die Lane-Puffer, die Abbruch-Steuerung und die Lane-Bindung
 * (welcher Endpunkt zuletzt eine Lane bedient hat).
 */
@Injectable()
export class ResearchLiveService {
  private readonly runs = new Map<string, Run>();

  private run(id: string): Run {
    let r = this.runs.get(id);
    if (!r) {
      r = { lanes: new Map(), subs: new Set(), sticky: new Map() };
      this.runs.set(id, r);
    }
    return r;
  }

  /** Neuer Lauf: Lanes leer, frischer Controller. */
  begin(id: string): AbortController {
    const r = this.run(id);
    if (r.cleanup) clearTimeout(r.cleanup);
    r.cleanup = undefined;
    r.lanes.clear();
    r.controller = new AbortController();
    return r.controller;
  }

  controller(id: string): AbortController | undefined { return this.runs.get(id)?.controller; }
  abort(id: string): void { this.runs.get(id)?.controller?.abort(); }
  abortAll(): void { for (const r of this.runs.values()) r.controller?.abort(); }
  sticky(id: string, lane: string): string | undefined { return this.runs.get(id)?.sticky.get(lane); }
  setSticky(id: string, lane: string, endpointId: string): void { this.run(id).sticky.set(lane, endpointId); }

  emit(id: string, ev: LiveEvent): void {
    const r = this.run(id);
    if (ev.type === 'call') r.lanes.set(ev.lane, { text: '', reasoning: '', model: ev.model, active: true });
    if (ev.type === 'delta') {
      const lane = r.lanes.get(ev.lane) ?? { text: '', reasoning: '', active: true };
      if (ev.kind === 'content') lane.text = (lane.text + ev.text).slice(-LANE_BUFFER);
      else lane.reasoning = (lane.reasoning + ev.text).slice(-LANE_BUFFER);
      r.lanes.set(ev.lane, lane);
    }
    if (ev.type === 'idle') {
      const lane = r.lanes.get(ev.lane);
      if (lane) lane.active = false;
    }
    for (const cb of [...r.subs]) {
      try { cb(ev); } catch { r.subs.delete(cb); }
    }
  }

  snapshot(id: string): LiveEvent {
    const lanes: Record<string, Lane> = {};
    for (const [k, v] of this.runs.get(id)?.lanes ?? []) lanes[k] = { ...v };
    return { type: 'snapshot', lanes };
  }

  subscribe(id: string, cb: (ev: LiveEvent) => void): () => void {
    const r = this.run(id);
    r.subs.add(cb);
    return () => { r.subs.delete(cb); };
  }

  /** Lauf beendet: `end` senden, Controller entfernen, Puffer nach 60 s löschen. */
  end(id: string): void {
    const r = this.runs.get(id);
    if (!r) return;
    this.emit(id, { type: 'end' });
    r.controller = undefined;
    if (r.cleanup) clearTimeout(r.cleanup);
    r.cleanup = setTimeout(() => {
      if (r.subs.size === 0 && this.runs.get(id) === r) this.runs.delete(id);
    }, 60_000);
    r.cleanup.unref();
  }
}
