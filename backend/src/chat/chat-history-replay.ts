import { isRecord } from '../common/narrow';
import type { LlmMessage } from './chat-llm.service';
import { withCodeRefs } from './code-refs';
import type { ChatMessage } from './schemas/chat-session.schema';

/** Upper bound of the synthetic text replayed for a tool-only assistant turn. */
export const TOOL_SUMMARY_MAX_CHARS = 500;
const ARG_MAX_CHARS = 60;

/** The argument that names what a call worked on (path, command, query), shortened. */
function callTarget(rawArguments: string | undefined): string {
  if (!rawArguments) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return '';
  }
  if (!isRecord(parsed)) return '';
  const args = parsed;
  const pick = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
  };
  const from = pick('from');
  const to = pick('to');
  const target = from !== undefined && to !== undefined
    ? `${from} -> ${to}`
    : pick('path') ?? pick('command') ?? pick('query') ?? pick('title') ?? '';
  const oneLine = target.replace(/\s+/g, ' ').trim();
  return oneLine.length > ARG_MAX_CHARS ? `${oneLine.slice(0, ARG_MAX_CHARS - 1)}…` : oneLine;
}

/**
 * Short text standing in for an assistant turn that consists of tool calls
 * only (IDE agent), e.g. `[Werkzeuge: ws_read greet.js ✓, ws_edit greet.js ✓]`.
 * At most `TOOL_SUMMARY_MAX_CHARS`; calls that do not fit are counted.
 */
export function summarizeToolCalls(calls: readonly { name?: string; arguments?: string; success?: boolean }[]): string {
  const parts = calls.map((c) => {
    const target = callTarget(c.arguments);
    return `${c.name ?? 'tool'}${target ? ` ${target}` : ''} ${c.success === false ? '✗' : '✓'}`;
  });
  const open = '[Werkzeuge: ';
  const close = ']';
  let text = '';
  for (let i = 0; i < parts.length; i += 1) {
    const next = text ? `${text}, ${parts[i]}` : parts[i];
    const rest = parts.length - i - 1;
    const more = rest > 0 ? `, … +${rest}` : '';
    if ((open + next + more + close).length > TOOL_SUMMARY_MAX_CHARS) {
      const left = parts.length - i;
      text = text ? `${text}, … +${left}` : `… +${left}`;
      break;
    }
    text = next;
  }
  return `${open}${text}${close}`;
}

/**
 * The stored history as LLM messages: system messages dropped, the last
 * `limit` kept. An assistant turn without text but with tool calls (stored
 * IDE agent turn) is replayed as a short summary of its calls, so roles keep
 * alternating (strict chat templates refuse two user messages in a row) and
 * the agent remembers what it did. An assistant turn with neither is dropped
 * (providers refuse empty messages).
 */
export function historyToLlmMessages(history: readonly ChatMessage[], limit: number): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of history.slice(-limit)) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant' && m.content.trim() === '') {
      if (m.toolCalls && m.toolCalls.length > 0) out.push({ role: 'assistant', content: summarizeToolCalls(m.toolCalls) });
      continue;
    }
    const content = m.role === 'user' && m.codeRefs && m.codeRefs.length > 0 ? withCodeRefs(m.content, m.codeRefs) : m.content;
    out.push({ role: m.role, content });
  }
  return out;
}
