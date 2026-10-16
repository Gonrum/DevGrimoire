/**
 * Reine Logik der Recherche-Oberfläche (Webrecherche P2). Bewusst ohne Imports,
 * damit `scripts/research-lib-check.cjs` die Datei einzeln übersetzen und prüfen kann.
 * Die Regeln spiegeln `backend/src/research/research-control.service.ts`; weicht das
 * Backend ab, gewinnt das Backend (409), die Oberfläche blendet nur passend ein.
 */

export type ResearchStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type ResearchAction = 'cancel' | 'pause' | 'resume' | 'retry' | 'deepen' | 'move' | 'delete';
export type ResearchDepth = 'quick' | 'normal' | 'thorough';

export const RESEARCH_STATUSES: readonly ResearchStatus[] = ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'];
export const RESEARCH_MAX_FILES = 10;
export const RESEARCH_MAX_FILE_BYTES = 20 * 1024 * 1024;
const LANE_BUFFER = 30_000;

export function isActiveStatus(s: ResearchStatus): boolean {
  return s === 'queued' || s === 'running';
}

export function allowedActions(i: { status: ResearchStatus; hasReport: boolean; partial: boolean }): ResearchAction[] {
  const out: ResearchAction[] = [];
  if (i.status === 'queued' || i.status === 'running') out.push('cancel', 'pause');
  if (i.status === 'paused') out.push('cancel', 'resume');
  if (i.status === 'failed' && i.partial) out.push('resume');
  if (i.status === 'failed' || i.status === 'cancelled') out.push('retry');
  if (i.status === 'done') {
    if (i.hasReport) out.push('deepen');
    out.push('move');
  }
  out.push('delete');
  return out;
}

/** Wie im Backend (`stripTrailingSources`): nur ein abschließender `## Quellen`-Abschnitt. */
const TRAILING_SOURCES_RE = /\n+##[ \t]+Quellen[ \t]*\n(?![\s\S]*\n#{1,6}[ \t])[\s\S]*$/;

export function splitReport(content: string): { body: string; hasSourcesSection: boolean } {
  const m = TRAILING_SOURCES_RE.exec(content);
  if (!m) return { body: content, hasSourcesSection: false };
  return { body: content.slice(0, m.index).trimEnd(), hasSourcesSection: true };
}

/** Gleiche Form wie `CITE_RE` im Backend (`research-sources.ts`). */
const CITE_RE = /(?<!\w)\[(\^?)(\d+(?:\s*[-–]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–]\s*\d+)?)*)\]/g;
const MAX_RANGE = 20;

function numbersOf(inner: string): number[] {
  const out: number[] = [];
  for (const part of inner.split(/[,;]/)) {
    const range = /^\s*(\d+)\s*[-–]\s*(\d+)\s*$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let k = from; k <= to && k - from < MAX_RANGE; k++) out.push(k);
    } else {
      out.push(Number(part.trim()));
    }
  }
  return out.filter((n) => Number.isInteger(n) && n >= 1);
}

export function citedNumbers(text: string): number[] {
  const set = new Set<number>();
  for (const m of text.matchAll(CITE_RE)) for (const n of numbersOf(m[2])) set.add(n);
  return [...set].sort((a, b) => a - b);
}

/** Zerlegt Markdown in Code (Fences und Inline-Code) und Fließtext; nur Fließtext wird umgeschrieben. */
function mapOutsideCode(md: string, fn: (text: string) => string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('');
}

/** `[1, 3]` → `\[[1](#src-1), [3](#src-3)\]`; Nummern ohne Quelle bleiben Text, Klammern ohne bekannte Nummer unverändert. */
export function linkCitations(body: string, known: ReadonlySet<number>): string {
  return mapOutsideCode(body, (text) => text.replace(CITE_RE, (whole: string, _caret: string, inner: string) => {
    if (!numbersOf(inner).some((n) => known.has(n))) return whole;
    const linked = inner.replace(/\d+/g, (d) => (known.has(Number(d)) ? `[${d}](#src-${d})` : d));
    return `\\[${linked}\\]`;
  }));
}

export interface LiveLane {
  text: string;
  reasoning: string;
  model?: string;
  active: boolean;
  /** Belegung der Endpunkte, solange die Lane auf einen Platz wartet. */
  busy?: Record<string, number>;
}

export interface LiveState {
  lanes: Record<string, LiveLane>;
  ended: boolean;
}

export function emptyLive(): LiveState {
  return { lanes: {}, ended: false };
}

function rec(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = val;
  return out;
}

function numberRecord(v: unknown): Record<string, number> {
  const r = rec(v);
  if (!r) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(r)) if (typeof n === 'number') out[k] = n;
  return out;
}

/** Reducer für die SSE-Ereignisse von `GET /api/research/:id/live`. Unbekanntes lässt den Zustand unverändert (gleiche Referenz). */
export function applyLiveEvent(state: LiveState, ev: unknown): LiveState {
  const e = rec(ev);
  if (!e) return state;
  const lane = typeof e.lane === 'string' ? e.lane : null;
  switch (e.type) {
    case 'snapshot': {
      const src = rec(e.lanes);
      if (!src) return state;
      const lanes: Record<string, LiveLane> = {};
      for (const [k, v] of Object.entries(src)) {
        const l = rec(v);
        if (!l) continue;
        lanes[k] = {
          text: typeof l.text === 'string' ? l.text : '',
          reasoning: typeof l.reasoning === 'string' ? l.reasoning : '',
          ...(typeof l.model === 'string' ? { model: l.model } : {}),
          active: l.active === true,
        };
      }
      return { lanes, ended: false };
    }
    case 'call':
      if (!lane || typeof e.model !== 'string') return state;
      return { ...state, lanes: { ...state.lanes, [lane]: { text: '', reasoning: '', model: e.model, active: true } } };
    case 'wait': {
      if (!lane) return state;
      const prev = state.lanes[lane] ?? { text: '', reasoning: '', active: true };
      return { ...state, lanes: { ...state.lanes, [lane]: { ...prev, active: true, busy: numberRecord(e.busy) } } };
    }
    case 'delta': {
      if (!lane || typeof e.text !== 'string' || (e.kind !== 'content' && e.kind !== 'reasoning')) return state;
      const prev = state.lanes[lane] ?? { text: '', reasoning: '', active: true };
      const next: LiveLane = e.kind === 'content'
        ? { ...prev, text: (prev.text + e.text).slice(-LANE_BUFFER) }
        : { ...prev, reasoning: (prev.reasoning + e.text).slice(-LANE_BUFFER) };
      delete next.busy;
      return { ...state, lanes: { ...state.lanes, [lane]: next } };
    }
    case 'idle': {
      if (!lane || !state.lanes[lane]) return state;
      return { ...state, lanes: { ...state.lanes, [lane]: { ...state.lanes[lane], active: false } } };
    }
    case 'end': {
      const lanes: Record<string, LiveLane> = {};
      for (const [k, l] of Object.entries(state.lanes)) lanes[k] = { ...l, active: false };
      return { lanes, ended: true };
    }
    default:
      return state;
  }
}

/** Wie `TEXT_EXT` in `backend/src/research/research-files.ts`, plus PDF. */
const FILE_EXT_RE = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log|ini|toml|sql|js|ts|tsx|jsx|py|java|cs|go|rs|php|rb|sh|pdf)$/i;

/** Vorprüfung vor dem Upload; liefert einen i18n-Schlüssel oder `null`. Das Backend prüft trotzdem. */
export function validateResearchFiles(files: Array<{ name: string; size: number }>): string | null {
  if (files.length > RESEARCH_MAX_FILES) return 'researchRun.errors.fileCount';
  for (const f of files) {
    if (!FILE_EXT_RE.test(f.name)) return 'researchRun.errors.fileType';
    if (f.size > RESEARCH_MAX_FILE_BYTES) return 'researchRun.errors.fileSize';
  }
  return null;
}

export function parseMoveTarget(hint: string | undefined | null): { kind: 'project' | 'customer'; id: string } | null {
  const m = /^(project|customer):([0-9a-f]{24})$/.exec(hint ?? '');
  if (!m) return null;
  return { kind: m[1] === 'project' ? 'project' : 'customer', id: m[2] };
}
