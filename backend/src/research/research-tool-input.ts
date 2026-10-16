import type { ResearchDepth } from './research-types';
import { isRecord, isUnknownArray } from '../common/narrow';
import { idToString } from '../common/tool-args';

const DEPTHS: readonly ResearchDepth[] = ['quick', 'normal', 'thorough'];

/** Themen aus Tool-Argumenten: `topic` (String) und/oder `topics` (Array oder — von Modellen oft — ein String). */
export function readTopics(args: Readonly<Record<string, unknown>>): string[] {
  const raw: unknown[] = [];
  if (typeof args.topic === 'string') raw.push(args.topic);
  if (typeof args.topics === 'string') raw.push(args.topics);
  else if (isUnknownArray(args.topics)) raw.push(...args.topics);
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function readDepth(args: Readonly<Record<string, unknown>>): ResearchDepth {
  const d = args.depth;
  if (d === undefined || d === null || d === '') return 'normal';
  const hit = DEPTHS.find((x) => x === d);
  if (!hit) throw new Error(`depth must be one of ${DEPTHS.join(', ')}`);
  return hit;
}

/**
 * Kompakter Stand einer Recherche für Agenten: kein Dateitext, keine Seiten-Notizen,
 * der Bericht nur bei `done` (vorher ist `content` leer oder ein alter Bericht).
 */
export function researchStatusForTool(doc: unknown, position: number | undefined): Record<string, unknown> {
  const d = isRecord(doc) ? doc : {};
  const tasks = isUnknownArray(d.tasks) ? d.tasks.filter(isRecord) : [];
  const sources = isUnknownArray(d.sourceList) ? d.sourceList.filter(isRecord) : [];
  const out: Record<string, unknown> = {
    id: idToString(d._id) ?? idToString(d.id) ?? '',
    title: d.title,
    status: d.status,
    depth: d.depth,
    projectId: d.projectId ?? null,
    customerId: d.customerId ?? null,
    roundsDone: d.roundsDone,
    error: d.error,
    tasks: tasks.map((t) => ({ n: t.n, question: t.question, status: t.status })),
  };
  if (position !== undefined) out.position = position;
  if (d.status === 'done') {
    out.report = d.content;
    out.sources = sources
      .filter((s) => s.relevant === true)
      .map((s) => (s.file ? { n: s.n, file: s.file, title: s.title } : { n: s.n, url: s.url, title: s.title }));
  }
  return out;
}
