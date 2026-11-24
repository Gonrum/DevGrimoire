import { BadRequestException } from '@nestjs/common';

/** What the IDE agent may do without asking again, stored per workspace. */
export const AGENT_ALLOW_FILE_KINDS = ['files.write', 'files.structure', 'files.delete'] as const;
export type AgentAllowFileKind = (typeof AGENT_ALLOW_FILE_KINDS)[number];
export const AGENT_ALLOW_KINDS = [...AGENT_ALLOW_FILE_KINDS, 'command'] as const;
export type AgentAllowKind = (typeof AGENT_ALLOW_KINDS)[number];
/**
 * `prefix` is legacy: such rules can no longer be created and never allow
 * anything (too many programs run arbitrary commands through their own
 * options); stored ones remain readable and deletable.
 */
export const AGENT_ALLOW_MATCHES = ['exact', 'prefix'] as const;
export type AgentAllowMatch = (typeof AGENT_ALLOW_MATCHES)[number];

export type AgentAllowEntry =
  | { kind: AgentAllowFileKind; createdAt: Date }
  | { kind: 'command'; match: AgentAllowMatch; value: string; createdAt: Date };

/** Input of POST /workspaces/:id/agent-allow (no createdAt). Commands: exact only. */
export type AgentAllowInput =
  | { kind: AgentAllowFileKind }
  | { kind: 'command'; match: 'exact'; value: string };

export const AGENT_ALLOW_MAX_ENTRIES = 100;
export const AGENT_ALLOW_VALUE_MAX = 500;

/** A stored command rule that is not `exact` (legacy prefix): shown, deletable, never applied. */
export function isInactiveAllowEntry(entry: { kind: string; match?: unknown }): boolean {
  return entry.kind === 'command' && entry.match !== 'exact';
}

/**
 * Edge trimming of commands and stored command values: spaces and tabs only,
 * the same on both sides of a comparison (NBSP, U+2028 … stay significant).
 */
export function trimCommandEdges(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, '');
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
  if (raw.match === 'prefix') {
    throw new BadRequestException('prefix rules are no longer supported; allow the exact command');
  }
  if (raw.match !== 'exact') throw new BadRequestException('match must be "exact"');
  if (typeof raw.value !== 'string') throw new BadRequestException('value must be a string');
  const value = trimCommandEdges(raw.value);
  if (!value || value.length > AGENT_ALLOW_VALUE_MAX) {
    throw new BadRequestException(`value must be 1-${AGENT_ALLOW_VALUE_MAX} characters`);
  }
  return { kind, match: 'exact', value };
}
