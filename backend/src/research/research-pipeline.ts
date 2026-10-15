import { errorMessage, isRecord, isUnknownArray } from '../common/tool-args';
import { FILE_DIGEST, INJECTION_GUARD, PIPELINE, TASK_LIMITS, type LimitKind } from './research-config';
import { splitParts } from './research-files';
import { budgetExhausted, Interrupted, TOKEN_BUDGET_EXHAUSTED } from './research-llm.service';
import {
  REPORT_RULES, filesBlock, followUpsBlock, relatedBlock, resultsBlock, wrapUntrusted, type RoundResult,
} from './research-prompts';
import { throwIfAborted, type RunContext } from './research-run-context';
import type { TaskInput, TaskOutcome } from './research-task-agent';

const MIN_REPORT = 200;
const MAX_QUERIES = 3;
const PAGE_NOTES_CHARS = 1_500;

/** Erstes `{...}` der Antwort, auch in ```json-Zäunen. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function focusLine(ctx: RunContext): string {
  return ctx.focus ? `\nFocus: ${ctx.focus}` : '';
}

/** Antworttext; `exhausted` = Token-Budget ohne verwertbare Antwort aufgebraucht (als Schritt protokolliert). */
async function askFull(ctx: RunContext, lane: string, kind: LimitKind, prompt: string): Promise<{ text: string; exhausted: boolean }> {
  throwIfAborted(ctx);
  const res = await ctx.llm.call({
    researchId: ctx.researchId,
    lane,
    kind,
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    signal: ctx.signal,
    onReroute: ctx.onReroute(lane),
  });
  ctx.models.add(res.model);
  const exhausted = budgetExhausted(res);
  if (exhausted) ctx.step('error', TOKEN_BUDGET_EXHAUSTED, lane);
  return { text: res.text, exhausted };
}

async function ask(ctx: RunContext, lane: string, kind: LimitKind, prompt: string): Promise<string> {
  return (await askFull(ctx, lane, kind, prompt)).text;
}

/** Wartet auf alle Zweige; `Interrupted` wird weitergeworfen, andere Fehler als Schritt protokolliert. */
async function settleAll(ctx: RunContext, branches: Array<{ lane: string; run: Promise<void> }>): Promise<void> {
  const settled = await Promise.allSettled(branches.map((b) => b.run));
  let interrupted: Interrupted | undefined;
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') return;
    if (res.reason instanceof Interrupted) { interrupted ??= res.reason; return; }
    ctx.step('error', errorMessage(res.reason), branches[i].lane);
  });
  if (interrupted) throw interrupted;
}

function relevantNotes(parsed: Record<string, unknown> | null): string | null {
  if (!parsed || parsed.relevant !== true || typeof parsed.notes !== 'string') return null;
  const notes = parsed.notes.trim();
  return notes === '' ? null : notes;
}

export async function digestFiles(ctx: RunContext): Promise<void> {
  const todo = ctx.files.filter((f) => !ctx.registry.get(f.n)?.file);
  for (const file of todo) file.n = ctx.registry.addFile(file.name).n;

  const branches = ctx.files.map((file) => {
    const lane = `f${file.n}`;
    const run = async (): Promise<void> => {
      const parts = splitParts(file.text, FILE_DIGEST.chunkChars).slice(0, FILE_DIGEST.maxChunks);
      const collected: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const prompt = `Topic: ${ctx.topic}${focusLine(ctx)}
Below is part ${i + 1} of ${parts.length} of the uploaded file "${file.name.replace(/\s+/g, ' ').trim()}".
Note in German everything in it that helps answer the topic (facts, figures with dates, claims).
Reply ONLY with JSON: {"relevant": true|false, "notes": "..."}.
${INJECTION_GUARD}

--- FILE PART ---
${wrapUntrusted('', 'FILE', parts[i])}`;
        const notes = relevantNotes(parseJsonObject(await ask(ctx, lane, 'notes', prompt)));
        if (notes !== null) collected.push(notes);
      }
      file.notes = collected.join('\n').slice(0, FILE_DIGEST.notesChars);
      if (collected.length > 0) ctx.registry.markRelevant(file.n, file.notes);
      ctx.step('read', `Datei ausgewertet: ${file.name}`, lane);
    };
    return { lane, run: run() };
  });
  await settleAll(ctx, branches);
}

interface PlannedTask { question: string; queries: string[] }

function readPlannedTasks(parsed: Record<string, unknown>, ctx: RunContext): PlannedTask[] {
  if (!isUnknownArray(parsed.tasks)) return [];
  const out: PlannedTask[] = [];
  for (const raw of parsed.tasks) {
    if (!isRecord(raw) || typeof raw.question !== 'string' || raw.question.trim() === '') continue;
    const question = raw.question.trim();
    const given = isUnknownArray(raw.queries)
      ? raw.queries.filter((q): q is string => typeof q === 'string' && q.trim() !== '').map((q) => q.trim())
      : [];
    const queries = given.filter((q) => !ctx.usedQueries.has(q.toLowerCase().trim())).slice(0, MAX_QUERIES);
    if (queries.length === 0) {
      if (ctx.usedQueries.has(question.toLowerCase())) continue;
      queries.push(question);
    }
    out.push({ question, queries });
  }
  return out.slice(0, ctx.cfg.tasks);
}

export async function planTasks(
  ctx: RunContext, round: number, previous: RoundResult[],
): Promise<{ enough: boolean; tasks: PlannedTask[] }> {
  const head = `Topic: ${ctx.topic}${focusLine(ctx)}${ctx.question ? `\nFollow-up question: ${ctx.question}` : ''}`;
  const format = 'Reply ONLY with JSON: {"enough": boolean, "tasks": [{"question": string, "queries": string[]}]}.';
  const prompt = round <= 1
    ? `${head}
Plan ${ctx.cfg.tasks} sub-questions from different angles: overview, details and figures, recent developments, criticism and problems. 1–2 search queries each.
${format}${filesBlock(ctx)}`
    : `${head}
--- NOTES ---
${wrapUntrusted('Results so far:', 'RESULTS', resultsBlock(previous))}
Are there important gaps? If not, set enough to true. Otherwise plan up to ${ctx.cfg.tasks} new sub-questions that close them, 1–2 search queries each.
${format}`;
  const parsed = parseJsonObject(await ask(ctx, 'main', 'leadPlan', `${prompt}\n${INJECTION_GUARD}`));
  const tasks = parsed ? readPlannedTasks(parsed, ctx) : [];
  if (round <= 1) {
    if (tasks.length === 0) return { enough: false, tasks: [{ question: ctx.topic, queries: [ctx.topic] }] };
    return { enough: false, tasks };
  }
  if (!parsed || parsed.enough === true || tasks.length === 0) return { enough: true, tasks: [] };
  return { enough: false, tasks };
}

interface Candidate { url: string; title: string; snippet: string }

async function collectCandidates(ctx: RunContext, task: TaskInput, lane: string): Promise<Candidate[]> {
  const counts = new Map<string, { hit: Candidate; count: number; order: number }>();
  let order = 0;
  for (const query of task.queries.slice(0, TASK_LIMITS.maxSearches)) {
    throwIfAborted(ctx);
    ctx.usedQueries.add(query.toLowerCase().trim());
    ctx.step('search', query, lane);
    let hits;
    try {
      hits = await ctx.web.search(query, ctx.signal);
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      ctx.step('error', `Suche fehlgeschlagen: ${errorMessage(err)}`, lane);
      continue;
    }
    for (const h of hits) {
      const prev = counts.get(h.url);
      if (prev) prev.count += 1;
      else counts.set(h.url, { hit: h, count: 1, order: order++ });
    }
  }
  return [...counts.values()]
    .filter((c) => !ctx.registry.isRead(c.hit.url))
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, PIPELINE.pickCandidates)
    .map((c) => c.hit);
}

async function pickUrls(ctx: RunContext, task: TaskInput, candidates: Candidate[], lane: string): Promise<string[]> {
  const list = candidates.map((c, i) => `${i}. ${c.title} — ${c.url} — ${c.snippet}`).join('\n');
  const prompt = `Topic: ${ctx.topic}${focusLine(ctx)}
Sub-question: ${task.question}
Pick the ${ctx.cfg.pages} most useful pages to read from the numbered candidates below.
Reply ONLY with JSON: {"picks": [index, ...]}.
${INJECTION_GUARD}

--- CANDIDATES ---
${wrapUntrusted('', 'PAGE', list)}`;
  const parsed = parseJsonObject(await ask(ctx, lane, 'short', prompt));
  const picked: number[] = [];
  if (parsed && isUnknownArray(parsed.picks)) {
    for (const p of parsed.picks) {
      if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < candidates.length && !picked.includes(p)) picked.push(p);
    }
  }
  for (let i = 0; i < candidates.length && picked.length < ctx.cfg.pages; i++) {
    if (!picked.includes(i)) picked.push(i);
  }
  return picked.slice(0, ctx.cfg.pages).map((i) => candidates[i].url);
}

export async function runFixedTask(ctx: RunContext, task: TaskInput): Promise<TaskOutcome> {
  const lane = `t${task.n}`;
  const failed: TaskOutcome = { status: 'failed', summary: '', sources: [] };
  const candidates = await collectCandidates(ctx, task, lane);
  if (candidates.length === 0) { ctx.step('error', `T${task.n} ohne Ergebnis`, lane); return failed; }

  const urls = (await pickUrls(ctx, task, candidates, lane)).filter((u) => {
    if (ctx.registry.claim(u)) return true;
    ctx.step('skip', u, lane);
    return false;
  });

  const notesByN = new Map<number, string>();
  const readSource = async (url: string): Promise<void> => {
    throwIfAborted(ctx);
    ctx.step('read', url, lane);
    let page;
    try {
      page = await ctx.web.fetch(url, PIPELINE.readChars, ctx.signal);
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      ctx.step('skip', url, lane);
      return;
    }
    const text = page.text.trim();
    if (text.length < TASK_LIMITS.minPageChars) { ctx.step('skip', url, lane); return; }
    const entry = ctx.registry.addPage(url, page.title, task.n);
    const prompt = `Topic: ${ctx.topic}${focusLine(ctx)}
Sub-question: ${task.question}
Below is the text of web page [${entry.n}] "${page.title.replace(/\s+/g, ' ').trim().slice(0, 200)}".
Note in German everything in it that helps answer the sub-question (facts, figures with dates, claims).
Reply ONLY with JSON: {"relevant": true|false, "notes": "..."}.
${INJECTION_GUARD}

--- PAGE ---
${wrapUntrusted('', 'PAGE', text.slice(0, PIPELINE.readChars))}`;
    const notes = relevantNotes(parseJsonObject(await ask(ctx, lane, 'notes', prompt)));
    if (notes === null) return;
    const kept = notes.slice(0, PAGE_NOTES_CHARS);
    ctx.registry.markRelevant(entry.n, kept);
    notesByN.set(entry.n, kept);
  };
  await settleAll(ctx, urls.map((u) => ({ lane, run: readSource(u) })));

  if (notesByN.size === 0) { ctx.step('error', `T${task.n} ohne Ergebnis`, lane); return failed; }
  const sources = [...notesByN.keys()].sort((a, b) => a - b);
  const notes = sources.map((n) => `[${n}] ${notesByN.get(n)}`).join('\n\n');
  const prompt = `Topic: ${ctx.topic}${focusLine(ctx)}
Sub-question: ${task.question}
Write a German summary of about 200 words answering the sub-question, based only on the notes below.
Every statement must cite its source number like [3]. Only cite numbers that appear in the notes. Do not invent facts.
${INJECTION_GUARD}

--- NOTES ---
${wrapUntrusted('', 'PAGE', notes)}`;
  const summary = (await ask(ctx, lane, 'notes', prompt)).trim();
  if (summary === '') { ctx.step('error', `T${task.n} ohne Ergebnis`, lane); return failed; }
  return { status: 'done', summary, sources };
}

export interface OrchestrateDeps {
  ctx: RunContext;
  roundsTotal: number;
  /** Wird vom Runner über runRound hochgezählt und hier neu gelesen. */
  roundsDone: number;
  previous: RoundResult[];
  runRound(tasks: Array<{ question: string; queries: string[] }>): Promise<RoundResult[]>;
}

export async function orchestrate(d: OrchestrateDeps): Promise<RoundResult[]> {
  const all = [...d.previous];
  while (d.roundsDone < d.roundsTotal) {
    throwIfAborted(d.ctx);
    const plan = await planTasks(d.ctx, d.roundsDone + 1, all);
    if (plan.enough || plan.tasks.length === 0) break;
    all.push(...await d.runRound(plan.tasks));
  }
  return all;
}

export interface ReportExtras { related: Array<{ title: string }>; followUps: string[] }

export async function writeReport(ctx: RunContext, results: RoundResult[], extras: ReportExtras): Promise<string> {
  const prompt = `Write the final research report.
Topic: ${ctx.topic}${focusLine(ctx)}
${followUpsBlock(extras.followUps)}${relatedBlock(extras.related)}${filesBlock(ctx)}
Results of the research assistants:
${wrapUntrusted('', 'RESULTS', resultsBlock(results))}

${REPORT_RULES}
${INJECTION_GUARD}`;
  const { text, exhausted } = await askFull(ctx, 'main', 'leadReport', prompt);
  if (exhausted) throw new Error(TOKEN_BUDGET_EXHAUSTED);
  if (text.trim().length < MIN_REPORT) throw new Error('Bericht zu kurz');
  return text;
}
