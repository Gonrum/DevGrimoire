import { BadRequestException } from '@nestjs/common';

/** What the IDE agent may do without asking again, stored per workspace. */
export const AGENT_ALLOW_FILE_KINDS = ['files.write', 'files.structure', 'files.delete'] as const;
export type AgentAllowFileKind = (typeof AGENT_ALLOW_FILE_KINDS)[number];
export const AGENT_ALLOW_KINDS = [...AGENT_ALLOW_FILE_KINDS, 'command'] as const;
export type AgentAllowKind = (typeof AGENT_ALLOW_KINDS)[number];
export const AGENT_ALLOW_MATCHES = ['exact', 'prefix'] as const;
export type AgentAllowMatch = (typeof AGENT_ALLOW_MATCHES)[number];

export type AgentAllowEntry =
  | { kind: AgentAllowFileKind; createdAt: Date }
  | { kind: 'command'; match: AgentAllowMatch; value: string; createdAt: Date };

/** Input of POST /workspaces/:id/agent-allow (no createdAt). */
export type AgentAllowInput =
  | { kind: AgentAllowFileKind }
  | { kind: 'command'; match: AgentAllowMatch; value: string };

export const AGENT_ALLOW_MAX_ENTRIES = 100;
export const AGENT_ALLOW_VALUE_MAX = 500;

/**
 * Shell control characters/sequences. A command containing any of them can chain
 * or redirect, so a `prefix` rule must neither contain nor match across them.
 * `(` and `)` cover subshells and substitutions of other shells (zsh `=(…)`,
 * fish `(…)`), in case a command ever reaches a non-POSIX shell.
 * Defined once; the matcher reuses it.
 */
export const SHELL_CONTROL_PATTERN = /;|&&|\|\||\||`|\$\(|>|<|&|\(|\)|\n|\r/;

export function hasShellControl(text: string): boolean {
  return SHELL_CONTROL_PATTERN.test(text);
}

/**
 * Edge trimming of commands and stored command values: spaces and tabs only,
 * the same on both sides of a comparison (NBSP, U+2028 … stay significant).
 */
export function trimCommandEdges(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * Interpreters and wrappers: a prefix starting with one of them allows
 * arbitrary code at any length (`bash -c …`, `env rm …`, `find . -exec …`),
 * so such commands can only be allowed exactly.
 */
export const AGENT_PREFIX_INTERPRETERS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'env', 'xargs', 'find', 'node', 'python', 'python3', 'perl',
  'ruby', 'php', 'npx', 'sudo', 'su', 'ssh', 'eval', 'exec', 'nohup', 'timeout', 'watch',
]);
/** Refused only as a one-word prefix (`git -c core.pager=…`); `git status` stays allowed. */
const AGENT_PREFIX_SINGLE_WORD_ONLY: ReadonlySet<string> = new Set(['git']);

/** First word, also given as a path (`/usr/bin/env` -> `env`). */
function commandWord(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/**
 * True when `value` must not be stored or matched as a `prefix` rule: its
 * first word is an interpreter/wrapper (any word count), or it is the single
 * word `git`.
 */
export function isForbiddenPrefix(value: string): boolean {
  const words = trimCommandEdges(value).split(/[ \t]+/).filter(Boolean);
  if (words.length === 0) return false;
  const first = commandWord(words[0]);
  if (AGENT_PREFIX_INTERPRETERS.has(first)) return true;
  return words.length === 1 && AGENT_PREFIX_SINGLE_WORD_ONLY.has(first);
}

/** Validates and normalises an agent-allow request body. Throws 400. */
export function parseAgentAllowInput(raw: {
  kind?: unknown;
  match?: unknown;
  value?: unknown;
}): AgentAllowInput {
  const kind = AGENT_ALLOW_KINDS.find((k) => k === raw.kind);
  if (!kind) throw new BadRequestException(`kind must be one of ${AGENT_ALLOW_KINDS.join(', ')}`);
  if (kind !== 'command') return { kind };
  const match = AGENT_ALLOW_MATCHES.find((m) => m === raw.match);
  if (!match) throw new BadRequestException('match must be "exact" or "prefix"');
  if (typeof raw.value !== 'string') throw new BadRequestException('value must be a string');
  const value = trimCommandEdges(raw.value);
  if (!value || value.length > AGENT_ALLOW_VALUE_MAX) {
    throw new BadRequestException(`value must be 1-${AGENT_ALLOW_VALUE_MAX} characters`);
  }
  if (match === 'prefix' && hasShellControl(value)) {
    throw new BadRequestException('a prefix rule must not contain shell control characters');
  }
  if (match === 'prefix' && isForbiddenPrefix(value)) {
    throw new BadRequestException(
      'a prefix rule must not start with an interpreter or wrapper (allow the exact command instead); '
        + 'git needs a second word, e.g. "git status"',
    );
  }
  return { kind, match, value };
}
