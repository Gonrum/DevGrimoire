import type { LlmMessageWithTools, OpenAiToolDef } from '../chat/chat-llm.service';
import { errorMessage, isRecord, isUnknownArray, requireString, type ToolArgs } from '../common/tool-args';
import { INJECTION_GUARD } from './research-config';
import { budgetExhausted, Interrupted, TOKEN_BUDGET_EXHAUSTED } from './research-llm.service';
import {
  filesBlock, followUpsBlock, relatedBlock, REPORT_RULES, resultsBlock, wrapUntrusted, type RoundResult,
} from './research-prompts';
import { throwIfAborted, type RunContext } from './research-run-context';

export interface LeadDeps {
  ctx: RunContext;
  roundsTotal: number;
  roundsDone: number;
  /** Ergebnisse früherer Runden (Fortsetzen/Vertiefen). */
  previous: RoundResult[];
  related: Array<{ title: string }>;
  /** Alle Nachfragen inkl. aktueller. */
  followUps: string[];
  /** Führt aus, persistiert, zählt roundsDone. */
  runRound(tasks: Array<{ question: string; queries: string[] }>): Promise<RoundResult[]>;
}

export interface LeadOutcome { report: string | null; roundsDone: number; results: RoundResult[] }

const MIN_REPORT = 200;

/** Hüllt Fehler aus runRound, damit sie nicht zu Werkzeug-Fehlertexten werden. */
class RoundFailure extends Error {
  constructor(readonly original: unknown) { super(errorMessage(original)); }
}

function leadSystemPrompt(d: LeadDeps): string {
  const { ctx } = d;
  const focusLine = ctx.focus ? `\nFocus: ${ctx.focus}` : '';
  const questionLine = ctx.question ? `\nFollow-up question: ${ctx.question}` : '';
  const roundsLeft = Math.max(0, d.roundsTotal - d.roundsDone);
  const previous = d.previous.length > 0
    ? `\nResults so far:\n${wrapUntrusted('', 'RESULTS', resultsBlock(d.previous))}`
    : '';
  return `You lead a web research project. You do NOT search yourself: you split the topic into sub-questions
and delegate each to a research assistant with run_subtasks. Each assistant searches the web, reads pages
and returns a short German summary with source numbers like [3]. You only see these summaries.

Topic: ${ctx.topic}${focusLine}${questionLine}
Research rounds available: ${roundsLeft} (each run_subtasks call is one round, up to ${ctx.cfg.tasks} sub-questions).

Round 1: cover different angles — overview, details and figures, recent developments, criticism and problems.
Later rounds: only for important gaps. When the results suffice, call write_report.
${relatedBlock(d.related)}${followUpsBlock(d.followUps)}${filesBlock(ctx)}${previous}
${REPORT_RULES}
${INJECTION_GUARD}`;
}

function leadTools(): OpenAiToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'run_subtasks',
        description: 'Run one research round: each task is delegated to a research assistant that searches the web and returns a German summary.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: { question: { type: 'string' }, queries: { type: 'array', items: { type: 'string' } } },
                required: ['question'],
              },
            },
          },
          required: ['tasks'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_report',
        description: 'Submit the final German Markdown report (without source list).',
        parameters: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] },
      },
    },
  ];
}

function parseArgs(raw: string): ToolArgs {
  const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
  if (!isRecord(parsed)) throw new Error('arguments must be a JSON object');
  return parsed;
}

function parseTasks(args: ToolArgs, max: number, used: Set<string>): Array<{ question: string; queries: string[] }> | null {
  const raw = args.tasks;
  if (!isUnknownArray(raw) || raw.length === 0) return null;
  const tasks: Array<{ question: string; queries: string[] }> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    if (question === '') continue;
    const given = isUnknownArray(item.queries)
      ? item.queries.filter((q): q is string => typeof q === 'string').map((q) => q.trim()).filter((q) => q !== '')
      : [];
    const fresh = given.filter((q) => !used.has(q.toLowerCase()));
    tasks.push({ question, queries: fresh.length > 0 ? fresh : [question] });
    if (tasks.length >= max) break;
  }
  return tasks.length > 0 ? tasks : null;
}

export async function runLeadAgent(d: LeadDeps): Promise<LeadOutcome> {
  const { ctx } = d;
  const results: RoundResult[] = [];
  const messages: LlmMessageWithTools[] = [
    { role: 'system', content: leadSystemPrompt(d) },
    { role: 'user', content: 'Start now.' },
  ];
  const tools = leadTools();
  const maxSteps = Math.max(0, d.roundsTotal - d.roundsDone) + 4;
  let report: string | null = null;
  let roundThisTurn = false;

  const runTool = async (name: string, rawArgs: string): Promise<string> => {
    let args: ToolArgs;
    try { args = parseArgs(rawArgs); } catch (err) {
      return `Error: invalid arguments: ${errorMessage(err)}`;
    }
    try {
      switch (name) {
        case 'run_subtasks': {
          if (roundThisTurn) return 'Error: only one research round per turn – wait for the results';
          if (d.roundsDone >= d.roundsTotal) return 'Error: no research rounds left – call write_report now';
          const tasks = parseTasks(args, ctx.cfg.tasks, ctx.usedQueries);
          if (!tasks) return 'Error: tasks must be a non-empty list';
          roundThisTurn = true;
          let round: RoundResult[];
          try {
            round = await d.runRound(tasks);
          } catch (err) {
            throw new RoundFailure(err);
          }
          results.push(...round);
          const left = Math.max(0, d.roundsTotal - d.roundsDone);
          return `${wrapUntrusted('', 'RESULTS', resultsBlock(round))}\n\nResearch rounds left: ${left}. Start another round for important gaps, or call write_report.`;
        }
        case 'write_report': {
          if (roundThisTurn) return 'Error: wait for the results of run_subtasks before writing the report';
          const text = requireString(args, 'report').trim();
          if (text.length < MIN_REPORT) return `Error: report too short (min ${MIN_REPORT} characters)`;
          if (!ctx.registry.all().some((s) => s.relevant)) return 'Error: no usable sources yet – run_subtasks first';
          report = text;
          return 'OK';
        }
        default:
          return `Error: unknown tool: ${name}`;
      }
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      if (err instanceof RoundFailure) throw err.original instanceof Error ? err.original : err;
      return `Error: ${errorMessage(err)}`;
    }
  };

  for (let stepNo = 0; stepNo < maxSteps; stepNo++) {
    throwIfAborted(ctx);
    if (stepNo === maxSteps - 2) {
      messages.push({
        role: 'user',
        content: 'Only one step left: call write_report now with the best report you can write from the results so far.',
      });
    }
    const res = await ctx.llm.call({
      researchId: ctx.researchId,
      lane: 'main',
      kind: 'leadReport',
      messages,
      tools,
      signal: ctx.signal,
      onReroute: ctx.onReroute('main'),
    });
    ctx.models.add(res.model);
    if (budgetExhausted(res)) ctx.step('error', TOKEN_BUDGET_EXHAUSTED, 'main');
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
    roundThisTurn = false;
    for (const call of res.toolCalls) {
      throwIfAborted(ctx);
      const content = await runTool(call.name, call.arguments);
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
      if (report !== null) return { report, roundsDone: d.roundsDone, results };
    }
  }
  return { report: null, roundsDone: d.roundsDone, results };
}
