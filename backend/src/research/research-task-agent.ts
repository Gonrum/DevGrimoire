import type { LlmMessageWithTools, OpenAiToolDef } from '../chat/chat-llm.service';
import { errorMessage, isRecord, isUnknownArray, requireNumber, requireString, type ToolArgs } from '../common/tool-args';
import { INJECTION_GUARD, TASK_LIMITS } from './research-config';
import { splitParts } from './research-files';
import { wrapUntrusted } from './research-prompts';
import { budgetExhausted, Interrupted, TOKEN_BUDGET_EXHAUSTED } from './research-llm.service';
import { throwIfAborted, type RunContext } from './research-run-context';
import { citedSourcesOf, normalizeUrl } from './research-sources';

export interface TaskInput { n: number; question: string; queries: string[] }
export interface TaskOutcome { status: 'done' | 'failed'; summary: string; sources: number[] }

const MIN_SUMMARY = 40;

function taskSystemPrompt(ctx: RunContext, task: TaskInput): string {
  const focusLine = ctx.focus ? `\nFocus: ${ctx.focus}` : '';
  const filesLine = ctx.files.length > 0
    ? `Uploaded files are available via read_file: ${ctx.files.map((f) => `[${f.n}] ${f.name}`).join(', ')}`
    : '';
  return `You are a research assistant working on ONE sub-question of a larger research topic.
Topic: ${ctx.topic}${focusLine}
Your sub-question: ${task.question}
Suggested search queries: ${task.queries.join('; ')}

Work like this: search the web (max ${TASK_LIMITS.maxSearches} searches), read the most promising pages (max ${ctx.cfg.pages} pages),
then call submit_findings with a German summary of about 200 words that answers the sub-question.
Every statement in the summary must cite its source number like [3]. Only cite sources you actually read.
Do not invent facts. If sources disagree, say so. Give dates for figures.
${filesLine}
${INJECTION_GUARD}`;
}

function fallbackSystemPrompt(ctx: RunContext, task: TaskInput): string {
  const focusLine = ctx.focus ? `\nFocus: ${ctx.focus}` : '';
  return `You are a research assistant working on ONE sub-question of a larger research topic.
Topic: ${ctx.topic}${focusLine}
Your sub-question: ${task.question}

Write a German summary of about 200 words that answers the sub-question, based only on the source excerpts you are given.
Every statement must cite its source number like [3]. Only cite sources that appear in the excerpts.
Do not invent facts. If sources disagree, say so. Give dates for figures.
${INJECTION_GUARD}`;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): OpenAiToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

function taskTools(withFiles: boolean): OpenAiToolDef[] {
  const tools = [
    tool('web_search', 'Search the web. Returns numbered hits with title, URL and snippet.', { query: { type: 'string' } }, ['query']),
    tool('read_page', 'Read one web page by URL. Returns the text as a numbered source.', { url: { type: 'string' } }, ['url']),
  ];
  if (withFiles) {
    tools.push(tool('read_file', 'Read one part of an uploaded file.', { source: { type: 'number' }, part: { type: 'number' } }, ['source', 'part']));
  }
  tools.push(tool(
    'submit_findings',
    'Submit the final German summary with [n] citations.',
    { summary: { type: 'string' }, used_sources: { type: 'array', items: { type: 'number' } } },
    ['summary'],
  ));
  return tools;
}

function oneLine(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function parseArgs(raw: string): ToolArgs {
  const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
  if (!isRecord(parsed)) throw new Error('arguments must be a JSON object');
  return parsed;
}

function numberList(args: ToolArgs, field: string): number[] {
  const val = args[field];
  if (val === undefined || val === null) return [];
  if (!isUnknownArray(val)) throw new Error(`${field} must be an array of numbers`);
  return val.filter((x): x is number => typeof x === 'number' && Number.isInteger(x));
}

/** Markiert die tatsächlich gelesenen Quellen als relevant und liefert ihre Nummern. */
function finish(ctx: RunContext, read: Map<number, string>, wanted: Iterable<number>): number[] {
  const out = [...new Set(wanted)].filter((n) => read.has(n)).sort((a, b) => a - b);
  for (const n of out) ctx.registry.markRelevant(n, (read.get(n) ?? '').slice(0, TASK_LIMITS.notesChars));
  return out;
}

async function fallbackSummary(ctx: RunContext, task: TaskInput, read: Map<number, string>, lane: string): Promise<TaskOutcome> {
  if (read.size > 0) {
    throwIfAborted(ctx);
    const excerpts = [...read.entries()]
      .map(([n, text]) => wrapUntrusted(`Source [${n}] – ${oneLine(ctx.registry.get(n)?.title ?? '')}`, 'PAGE', text.slice(0, TASK_LIMITS.notesChars)))
      .join('\n\n');
    const res = await ctx.llm.call({
      researchId: ctx.researchId,
      lane,
      kind: 'notes',
      messages: [
        { role: 'system', content: fallbackSystemPrompt(ctx, task) },
        {
          role: 'user',
          content: `Based ONLY on these excerpts, write the German summary (about 200 words) of the sub-question now. Cite sources like [3].\n\n${excerpts}`,
        },
      ],
      tools: [],
      signal: ctx.signal,
      onReroute: ctx.onReroute(lane),
    });
    ctx.models.add(res.model);
    if (budgetExhausted(res)) ctx.step('error', TOKEN_BUDGET_EXHAUSTED, lane);
    const summary = res.text.trim();
    if (summary.length >= MIN_SUMMARY) {
      const sources = finish(ctx, read, read.keys());
      return { status: 'done', summary, sources };
    }
  }
  ctx.step('error', `T${task.n} ohne Ergebnis`, lane);
  return { status: 'failed', summary: '', sources: [] };
}

export async function runTaskAgent(ctx: RunContext, task: TaskInput): Promise<TaskOutcome> {
  const lane = `t${task.n}`;
  const read = new Map<number, string>();
  let searches = 0;
  let pageTries = 0;
  /** Normalisierte URLs aus den eigenen Suchtreffern — nur die dürfen gelesen werden. */
  const found = new Set<string>();
  const messages: LlmMessageWithTools[] = [
    { role: 'system', content: taskSystemPrompt(ctx, task) },
    { role: 'user', content: 'Start now.' },
  ];
  const tools = taskTools(ctx.files.length > 0);

  const runTool = async (name: string, rawArgs: string): Promise<{ content: string; done?: TaskOutcome }> => {
    let args: ToolArgs;
    try { args = parseArgs(rawArgs); } catch (err) {
      return { content: `Error: invalid arguments: ${errorMessage(err)}` };
    }
    try {
      switch (name) {
        case 'web_search': {
          const query = requireString(args, 'query');
          if (searches >= TASK_LIMITS.maxSearches) return { content: 'Error: search budget used up, read pages or call submit_findings' };
          searches++;
          ctx.usedQueries.add(query.toLowerCase().trim());
          ctx.step('search', query, lane);
          const hits = await ctx.web.search(query, ctx.signal);
          for (const h of hits) found.add(normalizeUrl(h.url));
          if (hits.length === 0) return { content: 'No results.' };
          return {
            content: hits
              .map((h, i) => `${i + 1}. ${h.title} — ${h.url} — ${h.snippet}${ctx.registry.isRead(h.url) ? ' (already read – skip)' : ''}`)
              .join('\n'),
          };
        }
        case 'read_page': {
          const url = requireString(args, 'url');
          // Kein Lesen beliebiger URLs: ein eingeschleuster Text könnte sonst Daten an eine fremde Adresse senden.
          if (!found.has(normalizeUrl(url))) return { content: 'Error: only pages from your search results can be read' };
          if (pageTries >= ctx.cfg.pages) return { content: 'Error: page budget used up, call submit_findings' };
          pageTries++;
          if (!ctx.registry.claim(url)) {
            ctx.step('skip', url, lane);
            return { content: 'Error: already read by another task – pick another page' };
          }
          ctx.step('read', url, lane);
          let page;
          try {
            page = await ctx.web.fetch(url, TASK_LIMITS.pageChars, ctx.signal);
          } catch (err) {
            if (err instanceof Interrupted) throw err;
            return { content: 'Error: page not readable' };
          }
          if (page.text.trim().length < TASK_LIMITS.minPageChars) return { content: 'Error: page not readable' };
          const text = page.text.slice(0, TASK_LIMITS.pageChars);
          const entry = ctx.registry.addPage(url, page.title, task.n);
          read.set(entry.n, text);
          return { content: wrapUntrusted(`Source [${entry.n}] – ${oneLine(page.title)}`, 'PAGE', text) };
        }
        case 'read_file': {
          if (ctx.files.length === 0) return { content: 'Error: unknown tool: read_file' };
          const n = requireNumber(args, 'source');
          const part = requireNumber(args, 'part');
          const file = ctx.files.find((f) => f.n === n);
          if (!file) return { content: `Error: no uploaded file with source number ${n}` };
          const parts = splitParts(file.text, TASK_LIMITS.fileChunk);
          if (!Number.isInteger(part) || part < 1 || part > parts.length) {
            return { content: `Error: part must be between 1 and ${parts.length}` };
          }
          ctx.step('read', file.name, lane);
          if (!read.has(n)) read.set(n, parts[part - 1]);
          return { content: wrapUntrusted(`Source [${n}] – ${oneLine(file.name)} (part ${part}/${parts.length})`, 'FILE', parts[part - 1]) };
        }
        case 'submit_findings': {
          const summary = requireString(args, 'summary').trim();
          if (summary.length < MIN_SUMMARY) return { content: 'Error: summary too short' };
          const sources = finish(ctx, read, [...numberList(args, 'used_sources'), ...citedSourcesOf(summary)]);
          return { content: 'OK', done: { status: 'done', summary, sources } };
        }
        default:
          return { content: `Error: unknown tool: ${name}` };
      }
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      return { content: `Error: ${errorMessage(err)}` };
    }
  };

  for (let stepNo = 0; stepNo < TASK_LIMITS.maxSteps; stepNo++) {
    throwIfAborted(ctx);
    if (stepNo === TASK_LIMITS.maxSteps - 2) {
      messages.push({ role: 'user', content: 'You have one step left. Call submit_findings now.' });
    }
    const res = await ctx.llm.call({
      researchId: ctx.researchId,
      lane,
      kind: 'notes',
      messages,
      tools,
      signal: ctx.signal,
      onReroute: ctx.onReroute(lane),
    });
    ctx.models.add(res.model);
    if (budgetExhausted(res)) ctx.step('error', TOKEN_BUDGET_EXHAUSTED, lane);
    if (res.toolCalls.length === 0) {
      // Leere Assistenten-Nachrichten erzeugen bei Anthropic einen leeren Textblock (400).
      if (res.text.trim() !== '') messages.push({ role: 'assistant', content: res.text });
      messages.push({ role: 'user', content: 'Continue by calling one of the tools.' });
      continue;
    }
    messages.push({
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })),
    });
    for (const call of res.toolCalls) {
      throwIfAborted(ctx);
      const out = await runTool(call.name, call.arguments);
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: out.content });
      if (out.done) return out.done;
    }
  }
  return fallbackSummary(ctx, task, read, lane);
}
