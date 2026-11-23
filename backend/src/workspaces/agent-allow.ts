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
 * Interpreters and wrappers: as a one-word prefix they would allow any
 * command (`bash -c …`, `env rm …`, `git -c core.pager=… …`). Two-word
 * prefixes such as `git status` stay allowed.
 */
export const AGENT_PREFIX_FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'env', 'xargs', 'find', 'node', 'python', 'python3', 'perl',
  'ruby', 'php', 'npx', 'sudo', 'su', 'ssh', 'git', 'eval', 'exec', 'nohup', 'timeout', 'watch',
]);

/** True for a single-word prefix value that names an interpreter/wrapper (also as a path, `/usr/bin/env`). */
export function isForbiddenSinglePrefix(value: string): boolean {
  const v = trimCommandEdges(value);
  if (!v || /[ \t]/.test(v)) return false;
  const base = v.slice(v.lastIndexOf('/') + 1);
  return AGENT_PREFIX_FORBIDDEN_WORDS.has(v) || AGENT_PREFIX_FORBIDDEN_WORDS.has(base);
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
  if (match === 'prefix' && isForbiddenSinglePrefix(value)) {
    throw new BadRequestException('a prefix rule must not be a single interpreter or wrapper word (use e.g. "git status")');
  }
  return { kind, match, value };
}
