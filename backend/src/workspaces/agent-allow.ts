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
 * Defined once; the matcher reuses it.
 */
export const SHELL_CONTROL_PATTERN = /;|&&|\|\||\||`|\$\(|>|<|&|\n|\r/;

export function hasShellControl(text: string): boolean {
  return SHELL_CONTROL_PATTERN.test(text);
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
  const value = raw.value.trim();
  if (!value || value.length > AGENT_ALLOW_VALUE_MAX) {
    throw new BadRequestException(`value must be 1-${AGENT_ALLOW_VALUE_MAX} characters`);
  }
  if (match === 'prefix' && hasShellControl(value)) {
    throw new BadRequestException('a prefix rule must not contain shell control characters');
  }
  return { kind, match, value };
}
