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
 * arbitrary code at any length (`bash -c …`, `env rm …`, `find . -exec …`,
 * `nice bash …`), so such commands can only be allowed exactly.
 */
export const AGENT_PREFIX_INTERPRETERS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'env', 'xargs', 'find', 'node', 'python', 'python3', 'perl',
  'ruby', 'php', 'npx', 'sudo', 'su', 'ssh', 'eval', 'exec', 'nohup', 'timeout', 'watch',
  'command', 'builtin', 'nice', 'stdbuf', 'setsid', 'doas', 'busybox', 'awk', 'gawk', 'bunx', 'time',
  'ionice', 'chroot', 'unshare', 'nsenter', 'script',
]);
/** Versioned interpreter names (`python3.12`, `node22`, `bash5`). */
const VERSIONED_INTERPRETER = /^(python|node|perl|ruby|php|bash|sh|zsh|lua|deno|bun)[0-9.]*$/;
/**
 * Tools whose second word decides what runs: refused as a single word, and
 * with an option as the second word (`git -c core.pager=…`, `npm --yes exec`).
 */
const AGENT_PREFIX_NEEDS_SUBCOMMAND: ReadonlySet<string> = new Set(['git', 'npm', 'pnpm', 'yarn']);
/** Package-runner subcommands that run arbitrary packages (`pnpm dlx`, `npm exec`, `yarn dlx`). */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);
const RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(['dlx', 'exec', 'x']);
/**
 * A plain word: what sh reads literally. No quotes, backslashes, `$`, globs,
 * `~`, braces, `!`, `#` — those let a word look harmless and still name
 * `bash` (`\bash`, `'bash'`, `b''ash`, `ba\sh`).
 */
const PLAIN_WORD = /^[A-Za-z0-9._+:=@%,/-]+$/;
/** `NAME=value` in front of a command: an assignment, the command comes after it. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * True when `value` must not be stored, suggested or matched as a `prefix`
 * rule. Valid prefixes consist of plain words only, do not start with an
 * assignment, and their first word (basename, lowercased) is no
 * interpreter/wrapper; git/npm/pnpm/yarn need a plain subcommand, and
 * `npm|pnpm|yarn dlx|exec|x` is refused. Exact rules are not affected.
 */
export function isForbiddenPrefix(value: string): boolean {
  const words = trimCommandEdges(value).split(/[ \t]+/).filter(Boolean);
  if (words.length === 0) return true;
  if (!words.every((w) => PLAIN_WORD.test(w))) return true;
  if (ENV_ASSIGNMENT.test(words[0])) return true;
  const first = words[0].slice(words[0].lastIndexOf('/') + 1).toLowerCase();
  if (AGENT_PREFIX_INTERPRETERS.has(first) || VERSIONED_INTERPRETER.test(first)) return true;
  if (AGENT_PREFIX_NEEDS_SUBCOMMAND.has(first)) {
    if (words.length === 1 || words[1].startsWith('-')) return true;
    if (PACKAGE_RUNNERS.has(first) && RUNNER_SUBCOMMANDS.has(words[1].toLowerCase())) return true;
  }
  return false;
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
      'a prefix rule must consist of plain words and must not start with an interpreter or wrapper '
        + '(allow the exact command instead); git/npm/pnpm/yarn need a subcommand, e.g. "git status"',
    );
  }
  return { kind, match, value };
}
