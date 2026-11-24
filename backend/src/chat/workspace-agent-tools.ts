import { HttpException, Injectable } from '@nestjs/common';
import { posix } from 'node:path';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { WorkspaceFsBackends } from '../workspaces/fs/workspace-fs-backends.service';
import { SshWorkspaceAccess } from '../workspaces/ssh-workspace-access.service';
import { WorkspaceLimitsService } from '../workspaces/workspace-limits.service';
import { LogsService } from '../logs/logs.service';
import { isRelativeWorkspacePath } from '../workspaces/dto/workspace-fs.dto';
import { logWorkspaceIde, openWorkspaceFs, type WorkspaceFsGateResult } from '../workspaces/workspace-fs-gate';
import {
  AGENT_ALLOW_VALUE_MAX,
  trimCommandEdges,
  type AgentAllowEntry,
  type AgentAllowFileKind,
  type AgentAllowInput,
} from '../workspaces/agent-allow';
import type { FsLimits } from '../workspaces/fs/workspace-fs-backend';
import { FS_EXEC_MAX_COMMAND_LENGTH } from '../workspaces/fs/workspace-fs-backend';
import { headTailText } from '../workspaces/fs/head-tail-output';
import { RequestContext } from '../common/request-context';
import { errorMessage, isRecord } from '../common/narrow';
import { optionalBoolean, optionalNumber, optionalStringArray, type ToolArgs } from '../common/tool-args';
import type { ToolDefinition, ToolExecutionResult } from './chat-tools';

export const WORKSPACE_AGENT_TOOLS: readonly string[] = [
  'ws_tree', 'ws_read', 'ws_search', 'ws_status',
  'ws_write', 'ws_edit', 'ws_mkdir', 'ws_move', 'ws_delete', 'ws_exec',
];

export const WORKSPACE_AGENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'ws_write', 'ws_edit', 'ws_mkdir', 'ws_move', 'ws_delete', 'ws_exec',
]);

export function isWorkspaceAgentTool(name: string): boolean {
  return WORKSPACE_AGENT_TOOLS.includes(name);
}

/** Which agent-allow file kind covers a file tool. */
const FILE_KIND_OF: Readonly<Record<string, AgentAllowFileKind>> = {
  ws_write: 'files.write',
  ws_edit: 'files.write',
  ws_mkdir: 'files.structure',
  ws_move: 'files.structure',
  ws_delete: 'files.delete',
};

/**
 * Pure; true when `entries` allow this call without asking. Read-only ws_*
 * tools never ask (true); any non-ws_* name is never covered (false).
 * Commands: only an `exact` entry whose value equals the command, both
 * trimmed of edge spaces/tabs. Stored prefix entries (legacy) are ignored.
 */
export function isAllowedByList(
  name: string,
  args: Record<string, unknown>,
  entries: readonly AgentAllowEntry[],
): boolean {
  if (!isWorkspaceAgentTool(name)) return false;
  if (!WORKSPACE_AGENT_WRITE_TOOLS.has(name)) return true;
  const fileKind = FILE_KIND_OF[name];
  if (fileKind) return entries.some((e) => e.kind === fileKind);
  // ws_exec
  if (typeof args.command !== 'string') return false;
  const command = trimCommandEdges(args.command);
  if (!command) return false;
  return entries.some((e) => e.kind === 'command' && e.match === 'exact' && trimCommandEdges(e.value) === command);
}

/**
 * Suggestions for the confirm card. ws_exec: the exact command (what the user
 * saw), left out when over the stored length limit. File tools: their files.*
 * kind. Anything else: none. `AgentAllowInput` is the entry union without
 * `createdAt` (a plain `Omit` over the union collapses it).
 */
export function allowSuggestions(name: string, args: Record<string, unknown>): AgentAllowInput[] {
  const fileKind = FILE_KIND_OF[name];
  if (fileKind) return [{ kind: fileKind }];
  if (name !== 'ws_exec' || typeof args.command !== 'string') return [];
  const command = trimCommandEdges(args.command);
  if (!command || command.length > AGENT_ALLOW_VALUE_MAX) return [];
  return [{ kind: 'command', match: 'exact', value: command }];
}

export interface AgentWorkspaceContext {
  workspaceId: string;
  /** Aborting ends a running ws_exec (turn cancelled, IDE closed). */
  signal?: AbortSignal;
}

export interface WsPreview {
  kind: 'file' | 'paths' | 'command';
  // file
  path?: string;
  before?: string | null;
  after?: string;
  baseHash?: string | null;
  // paths
  from?: string;
  to?: string;
  // command
  command?: string;
  timeoutSec?: number;
  cwd?: string;
  /** The command gets git tokens / DG_* (container with `agentCredentials`; never SSH). */
  credentials?: boolean;
}

export type WsToolResult = ToolExecutionResult & { changedPaths?: string[] };
export type WsPreviewResult = { ok: true; preview: WsPreview } | { ok: false; error: string };

/** Spec: output (stdout + stderr) handed to the LLM is cut to 64 KiB. */
export const WS_EXEC_OUTPUT_LIMIT = 64 * 1024;
/**
 * Per stream: half of the limit, as head + `… N bytes omitted …` + tail (the
 * backends collect it that way and never stop a command for its output).
 */
const WS_EXEC_STREAM_LIMIT = WS_EXEC_OUTPUT_LIMIT / 2;
const WS_EXEC_DEFAULT_TIMEOUT_SEC = 60;
const WS_EXEC_MAX_TIMEOUT_SEC = 600;
const PATH_MAX = 4096;
const SEARCH_QUERY_MAX = 500;
const SEARCH_GLOBS_MAX = 20;
const SEARCH_GLOB_LENGTH_MAX = 200;

const PATH_PROP = { type: 'string', description: 'Path relative to the workspace root' };
const BASE_HASH_PROP = {
  type: 'string',
  description: 'Hash from ws_read; the change fails with a conflict if the file changed since. Omit for a new file.',
};

export const WORKSPACE_AGENT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'ws_tree',
    description: 'Lists one directory level of the workspace (dirs first). Default path ".".',
    parameters: { type: 'object', properties: { path: PATH_PROP } },
  },
  {
    name: 'ws_read',
    description:
      'Reads a UTF-8 text file of the workspace. Optional 1-based inclusive line range. Returns content, '
      + 'hash (of the whole file) and totalLines.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        startLine: { type: 'number', description: 'First line, 1-based' },
        endLine: { type: 'number', description: 'Last line, inclusive' },
      },
      required: ['path'],
    },
  },
  {
    name: 'ws_search',
    description: 'Searches file contents of the workspace (ripgrep/grep). Optional include/exclude globs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        include: { type: 'array', items: { type: 'string' } },
        exclude: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  },
  {
    name: 'ws_status',
    description: 'git status of the workspace (branch, changed files).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'ws_write',
    description: 'Writes a whole text file (creates it if missing). Prefer ws_edit for small changes.',
    parameters: {
      type: 'object',
      properties: { path: PATH_PROP, content: { type: 'string' }, baseHash: BASE_HASH_PROP },
      required: ['path', 'content'],
    },
  },
  {
    name: 'ws_edit',
    description:
      'Replaces exactly one occurrence of oldText (literal, not a regex) with newText in a text file. '
      + 'Fails if oldText occurs zero or several times: then include more surrounding text.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        oldText: { type: 'string' },
        newText: { type: 'string' },
        baseHash: BASE_HASH_PROP,
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'ws_mkdir',
    description: 'Creates a directory (with parents).',
    parameters: { type: 'object', properties: { path: PATH_PROP }, required: ['path'] },
  },
  {
    name: 'ws_move',
    description: 'Moves or renames a file or directory.',
    parameters: {
      type: 'object',
      properties: { from: PATH_PROP, to: PATH_PROP },
      required: ['from', 'to'],
    },
  },
  {
    name: 'ws_delete',
    description: 'Deletes a file or a directory (recursively).',
    parameters: { type: 'object', properties: { path: PATH_PROP }, required: ['path'] },
  },
  {
    name: 'ws_exec',
    description:
      'Runs a shell command line (POSIX sh syntax) in the workspace root, without a TTY. timeoutSec default 60, max 600. '
      + 'Returns exitCode, stdout, stderr (each at most 32 KiB: start + "… N bytes omitted …" + end), '
      + 'truncated, timedOut, aborted.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, timeoutSec: { type: 'number' } },
      required: ['command'],
    },
  },
];

/** Bad tool input: the message goes to the LLM as is. */
class ToolInputError extends Error {}

type WsInput =
  | { tool: 'ws_tree'; path: string }
  | { tool: 'ws_read'; path: string; startLine?: number; endLine?: number }
  | {
    tool: 'ws_search';
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    include?: string[];
    exclude?: string[];
  }
  | { tool: 'ws_status' }
  | { tool: 'ws_write'; path: string; content: string; baseHash?: string }
  | { tool: 'ws_edit'; path: string; oldText: string; newText: string; baseHash?: string }
  | { tool: 'ws_mkdir' | 'ws_delete'; path: string }
  | { tool: 'ws_move'; from: string; to: string }
  | { tool: 'ws_exec'; command: string; timeoutSec: number };

/** Workspace-relative path, normalised; anything leaving the root is refused. */
function workspacePath(args: ToolArgs, field: string, fallback?: string): string {
  const raw = args[field] ?? fallback;
  if (typeof raw !== 'string' || raw === '') throw new ToolInputError(`${field} must be a non-empty relative path`);
  if (raw.length > PATH_MAX) throw new ToolInputError(`${field} too long (max ${PATH_MAX})`);
  if (!isRelativeWorkspacePath(raw)) throw new ToolInputError(`path outside workspace: ${raw}`);
  let norm = posix.normalize(raw);
  if (norm === '..' || norm.startsWith('../') || posix.isAbsolute(norm)) {
    throw new ToolInputError(`path outside workspace: ${raw}`);
  }
  if (norm.length > 1 && norm.endsWith('/')) norm = norm.slice(0, -1);
  return norm;
}

function textArg(args: ToolArgs, field: string, opts: { nonEmpty: boolean }): string {
  const v = args[field];
  if (typeof v !== 'string') throw new ToolInputError(`${field} must be a string`);
  if (opts.nonEmpty && v === '') throw new ToolInputError(`${field} must not be empty`);
  return v;
}

/** `baseHash` as the LLM gave it; null/absent both mean "not given". */
function baseHashArg(args: ToolArgs): string | undefined {
  const v = args.baseHash;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolInputError('baseHash must be a string');
  return v;
}

function lineArg(args: ToolArgs, field: string): number | undefined {
  const n = wrapArg(() => optionalNumber(args, field));
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 1) throw new ToolInputError(`${field} must be an integer >= 1`);
  return n;
}

/** tool-args helpers throw plain Errors; they are input errors here. */
function wrapArg<T>(fn: () => T): T {
  try { return fn(); } catch (err: unknown) { throw new ToolInputError(errorMessage(err)); }
}

function globsArg(args: ToolArgs, field: string): string[] | undefined {
  const list = wrapArg(() => optionalStringArray(args, field));
  if (!list) return undefined;
  if (list.length > SEARCH_GLOBS_MAX || list.some((g) => g.length > SEARCH_GLOB_LENGTH_MAX)) {
    throw new ToolInputError(`${field}: at most ${SEARCH_GLOBS_MAX} globs of ${SEARCH_GLOB_LENGTH_MAX} characters`);
  }
  return list;
}

function timeoutSecArg(args: ToolArgs): number {
  const t = wrapArg(() => optionalNumber(args, 'timeoutSec'));
  if (t === undefined || !Number.isFinite(t)) return WS_EXEC_DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.max(Math.floor(t), 1), WS_EXEC_MAX_TIMEOUT_SEC);
}

/** Validates the arguments of one call. workspaceId/projectId keys are never read. */
function parseInput(name: string, args: ToolArgs): WsInput {
  switch (name) {
    case 'ws_tree':
      return { tool: name, path: workspacePath(args, 'path', '.') };
    case 'ws_read': {
      const startLine = lineArg(args, 'startLine');
      const endLine = lineArg(args, 'endLine');
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        throw new ToolInputError('endLine must not be before startLine');
      }
      return { tool: name, path: workspacePath(args, 'path'), startLine, endLine };
    }
    case 'ws_search': {
      const query = textArg(args, 'query', { nonEmpty: true });
      if (query.length > SEARCH_QUERY_MAX) throw new ToolInputError(`query too long (max ${SEARCH_QUERY_MAX})`);
      return {
        tool: name,
        query,
        regex: wrapArg(() => optionalBoolean(args, 'regex')) === true,
        caseSensitive: wrapArg(() => optionalBoolean(args, 'caseSensitive')) === true,
        include: globsArg(args, 'include'),
        exclude: globsArg(args, 'exclude'),
      };
    }
    case 'ws_status':
      return { tool: name };
    case 'ws_write':
      return {
        tool: name,
        path: workspacePath(args, 'path'),
        content: textArg(args, 'content', { nonEmpty: false }),
        baseHash: baseHashArg(args),
      };
    case 'ws_edit':
      return {
        tool: name,
        path: workspacePath(args, 'path'),
        oldText: textArg(args, 'oldText', { nonEmpty: true }),
        newText: textArg(args, 'newText', { nonEmpty: false }),
        baseHash: baseHashArg(args),
      };
    case 'ws_mkdir':
    case 'ws_delete':
      return { tool: name, path: workspacePath(args, 'path') };
    case 'ws_move':
      return { tool: name, from: workspacePath(args, 'from'), to: workspacePath(args, 'to') };
    case 'ws_exec': {
      // Same edge trimming as the allow-list, so what was allowed is what runs.
      const command = trimCommandEdges(textArg(args, 'command', { nonEmpty: false }));
      if (!command.trim()) throw new ToolInputError('command must not be empty');
      if (command.length > FS_EXEC_MAX_COMMAND_LENGTH) {
        throw new ToolInputError(`command too long (max ${FS_EXEC_MAX_COMMAND_LENGTH})`);
      }
      if (command.includes('\0')) throw new ToolInputError('command must not contain NUL');
      return { tool: name, command, timeoutSec: timeoutSecArg(args) };
    }
    default:
      throw new ToolInputError(`unknown workspace tool "${name}"`);
  }
}

/** Lines of a text; a trailing newline does not start another line. */
function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Replaces the single occurrence of `oldText`; 0 or >1 (overlapping counted) -> input error. */
function replaceOnce(content: string, oldText: string, newText: string): string {
  const first = content.indexOf(oldText);
  if (first < 0) throw new ToolInputError('text not found');
  let count = 1;
  for (let i = content.indexOf(oldText, first + 1); i >= 0; i = content.indexOf(oldText, i + 1)) count += 1;
  if (count > 1) throw new ToolInputError(`text is ambiguous (${count} matches)`);
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}

function httpStatus(err: unknown): number | undefined {
  return err instanceof HttpException ? err.getStatus() : undefined;
}

function isConflict(err: unknown): boolean {
  if (!(err instanceof HttpException) || err.getStatus() !== 409) return false;
  const body = err.getResponse();
  return isRecord(body) && body.error === 'conflict';
}

/** Short English message the LLM can act on. */
function describeError(err: unknown): string {
  if (err instanceof ToolInputError) return err.message;
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const message = errorMessage(err);
    if (isRecord(body) && body.error === 'workspace_inactive') {
      const m = /^Workspace is (\S+), not active$/.exec(message);
      return m ? `workspace is ${m[1]}` : 'workspace is not active';
    }
    return message;
  }
  return errorMessage(err);
}

const NO_USER = 'no authenticated user';

type HashSource = 'pinned' | 'args' | 'fresh';
const CONFLICT_MESSAGE: Record<HashSource, string> = {
  pinned: 'conflict: file changed since the proposal',
  args: 'conflict: file changed since you read it; read it again',
  fresh: 'conflict: file changed while writing; try again',
};

/**
 * The IDE agent's workspace tools (`ws_*`). The workspace comes only from the
 * context (the chat session), never from the arguments. Every call and every
 * preview runs the same checks as the IDE `/fs` routes under the current
 * actor. Never throws: errors come back as `{ success:false }` / `{ ok:false }`.
 */
@Injectable()
export class WorkspaceAgentTools {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly backends: WorkspaceFsBackends,
    private readonly sshAccess: SshWorkspaceAccess,
    private readonly limits: WorkspaceLimitsService,
    private readonly logs: LogsService,
  ) {}

  definitions(): ToolDefinition[] {
    return [...WORKSPACE_AGENT_TOOL_DEFINITIONS];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: AgentWorkspaceContext,
    pinned?: { baseHash?: string | null },
  ): Promise<WsToolResult> {
    // Fail closed: every check below is "under the actor"; without one nothing vouches.
    if (!RequestContext.getUser()) return { success: false, error: NO_USER };
    let input: WsInput;
    try {
      input = parseInput(name, args);
    } catch (err: unknown) {
      return { success: false, error: describeError(err) };
    }
    let gate: WorkspaceFsGateResult;
    try {
      gate = await this.gate(ctx.workspaceId);
    } catch (err: unknown) {
      return { success: false, error: describeError(err) };
    }
    try {
      const out = await this.run(input, gate, ctx, pinned);
      this.workspaces.touchThrottled(ctx.workspaceId);
      return { success: true, result: out.result, ...(out.changedPaths ? { changedPaths: out.changedPaths } : {}) };
    } catch (err: unknown) {
      const error = describeError(err);
      if (WORKSPACE_AGENT_WRITE_TOOLS.has(input.tool)) {
        this.audit(gate, `${input.tool} failed: ${error}`, { tool: input.tool, error: error.slice(0, 500) }, 'warn');
      }
      return { success: false, error };
    }
  }

  async preview(name: string, args: Record<string, unknown>, ctx: AgentWorkspaceContext): Promise<WsPreviewResult> {
    if (!RequestContext.getUser()) return { ok: false, error: NO_USER };
    try {
      const input = parseInput(name, args);
      if (!WORKSPACE_AGENT_WRITE_TOOLS.has(input.tool)) {
        return { ok: false, error: `${input.tool} is read-only and needs no preview` };
      }
      const gate = await this.gate(ctx.workspaceId);
      return { ok: true, preview: await this.buildPreview(input, gate) };
    } catch (err: unknown) {
      return { ok: false, error: describeError(err) };
    }
  }

  private gate(workspaceId: string): Promise<WorkspaceFsGateResult> {
    return openWorkspaceFs(
      { workspaces: this.workspaces, backends: this.backends, sshAccess: this.sshAccess },
      workspaceId,
      { agent: true },
    );
  }

  private async fsLimits(): Promise<FsLimits> {
    const { editorMaxBytes, downloadMaxBytes } = await this.limits.get();
    return { editorMaxBytes, downloadMaxBytes };
  }

  private audit(
    gate: WorkspaceFsGateResult,
    text: string,
    metadata: Record<string, unknown>,
    level: 'info' | 'warn' = 'info',
  ): void {
    const id = gate.ws._id.toString();
    logWorkspaceIde(this.logs, gate.ws, id, `workspace_ide agent ${text}`.slice(0, 500), metadata, level, true);
  }

  private static assertContentFits(content: string, limits: FsLimits): void {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > limits.editorMaxBytes) {
      throw new ToolInputError(`content too large (>${limits.editorMaxBytes} bytes)`);
    }
  }

  /** Current content and hash, or null when the file does not exist (404). */
  private static async readOrNull(
    gate: WorkspaceFsGateResult,
    path: string,
    limits: FsLimits,
  ): Promise<{ content: string; hash: string } | null> {
    try {
      const r = await gate.backend.readText(path, limits);
      return { content: r.content, hash: r.hash };
    } catch (err: unknown) {
      if (httpStatus(err) === 404) return null;
      throw err;
    }
  }

  private async run(
    input: WsInput,
    gate: WorkspaceFsGateResult,
    ctx: AgentWorkspaceContext,
    pinned: { baseHash?: string | null } | undefined,
  ): Promise<{ result: unknown; changedPaths?: string[] }> {
    const { backend } = gate;
    switch (input.tool) {
      case 'ws_tree': {
        const res = await backend.listDir(input.path);
        const entries = res.entries.map((e) => ({
          name: posix.basename(e.path),
          path: e.path,
          type: e.type,
          ...(e.size !== undefined ? { size: e.size } : {}),
        }));
        entries.sort((a, b) => {
          const da = a.type === 'dir' ? 0 : 1;
          const db = b.type === 'dir' ? 0 : 1;
          return da - db || a.name.localeCompare(b.name);
        });
        return { result: { entries, truncated: res.truncated } };
      }
      case 'ws_read':
        return { result: await this.read(input, gate) };
      case 'ws_search':
        return {
          result: await backend.search({
            query: input.query,
            regex: input.regex,
            caseSensitive: input.caseSensitive,
            include: input.include,
            exclude: input.exclude,
          }),
        };
      case 'ws_status':
        return { result: await backend.status() };
      case 'ws_write':
        return this.write(input, gate, pinned);
      case 'ws_edit':
        return this.edit(input, gate, pinned);
      case 'ws_mkdir': {
        const res = await backend.mkdir(input.path);
        this.audit(gate, `mkdir: ${input.path}`, { tool: input.tool, path: input.path });
        return { result: { path: res.path }, changedPaths: [input.path] };
      }
      case 'ws_move': {
        const res = await backend.move(input.from, input.to);
        this.audit(gate, `move: ${input.from} -> ${input.to}`, { tool: input.tool, from: input.from, to: input.to });
        return { result: { from: res.from, to: res.to }, changedPaths: [input.from, input.to] };
      }
      case 'ws_delete':
        await backend.remove(input.path);
        this.audit(gate, `delete: ${input.path}`, { tool: input.tool, path: input.path });
        return { result: { deleted: input.path }, changedPaths: [input.path] };
      case 'ws_exec':
        return this.exec(input, gate, ctx);
    }
  }

  private async read(
    input: Extract<WsInput, { tool: 'ws_read' }>,
    gate: WorkspaceFsGateResult,
  ): Promise<Record<string, unknown>> {
    const res = await gate.backend.readText(input.path, await this.fsLimits());
    const lines = splitLines(res.content);
    const totalLines = lines.length;
    if (input.startLine === undefined && input.endLine === undefined) {
      return { path: input.path, content: res.content, hash: res.hash, totalLines };
    }
    const startLine = input.startLine ?? 1;
    if (startLine > totalLines) {
      throw new ToolInputError(`startLine ${startLine} is beyond the end of the file (${totalLines} lines)`);
    }
    const endLine = Math.min(input.endLine ?? totalLines, totalLines);
    return {
      path: input.path,
      content: lines.slice(startLine - 1, endLine).join('\n'),
      hash: res.hash,
      totalLines,
      startLine,
      endLine,
    };
  }

  private async write(
    input: Extract<WsInput, { tool: 'ws_write' }>,
    gate: WorkspaceFsGateResult,
    pinned: { baseHash?: string | null } | undefined,
  ): Promise<{ result: unknown; changedPaths: string[] }> {
    const limits = await this.fsLimits();
    WorkspaceAgentTools.assertContentFits(input.content, limits);
    let baseHash: string | null;
    let source: HashSource;
    if (pinned && pinned.baseHash !== undefined) {
      baseHash = pinned.baseHash;
      source = 'pinned';
    } else if (input.baseHash !== undefined) {
      baseHash = input.baseHash;
      source = 'args';
    } else {
      // Agents forget the hash: read it right before writing.
      baseHash = (await WorkspaceAgentTools.readOrNull(gate, input.path, limits))?.hash ?? null;
      source = 'fresh';
    }
    const res = await this.writeChecked(gate, input.path, input.content, baseHash, source, limits);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    this.audit(gate, `write: ${input.path}`, { tool: input.tool, path: input.path, bytes });
    return { result: { path: input.path, hash: res.hash, bytes }, changedPaths: [input.path] };
  }

  private async edit(
    input: Extract<WsInput, { tool: 'ws_edit' }>,
    gate: WorkspaceFsGateResult,
    pinned: { baseHash?: string | null } | undefined,
  ): Promise<{ result: unknown; changedPaths: string[] }> {
    const limits = await this.fsLimits();
    const current = await gate.backend.readText(input.path, limits);
    const source: HashSource = pinned && pinned.baseHash !== undefined
      ? 'pinned'
      : input.baseHash !== undefined ? 'args' : 'fresh';
    const expected = source === 'pinned' ? pinned?.baseHash : input.baseHash;
    if (source !== 'fresh' && expected !== current.hash) throw new ToolInputError(CONFLICT_MESSAGE[source]);
    const next = replaceOnce(current.content, input.oldText, input.newText);
    WorkspaceAgentTools.assertContentFits(next, limits);
    const res = await this.writeChecked(gate, input.path, next, current.hash, source, limits);
    const bytes = Buffer.byteLength(next, 'utf8');
    this.audit(gate, `edit: ${input.path}`, { tool: input.tool, path: input.path, bytes });
    return { result: { path: input.path, hash: res.hash, bytes }, changedPaths: [input.path] };
  }

  /** writeText with the backend's own hash check; a 409 conflict gets the agent-facing text. */
  private async writeChecked(
    gate: WorkspaceFsGateResult,
    path: string,
    content: string,
    baseHash: string | null,
    source: HashSource,
    limits: FsLimits,
  ): Promise<{ hash: string }> {
    try {
      return await gate.backend.writeText(path, content, { baseHash, force: false }, limits);
    } catch (err: unknown) {
      if (isConflict(err)) throw new ToolInputError(CONFLICT_MESSAGE[source]);
      throw err;
    }
  }

  private async exec(
    input: Extract<WsInput, { tool: 'ws_exec' }>,
    gate: WorkspaceFsGateResult,
    ctx: AgentWorkspaceContext,
  ): Promise<{ result: unknown; changedPaths: string[] }> {
    const startedAt = Date.now();
    const r = await gate.backend.exec(input.command, {
      timeoutMs: input.timeoutSec * 1000,
      maxOutputBytes: WS_EXEC_STREAM_LIMIT,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    // The backends already keep head + tail within the limit; this only guards it.
    const stdout = headTailText(r.stdout, WS_EXEC_STREAM_LIMIT);
    const stderr = headTailText(r.stderr, WS_EXEC_STREAM_LIMIT);
    const result = {
      exitCode: r.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: r.truncated || stdout.cut || stderr.cut,
      timedOut: r.timedOut,
      aborted: r.aborted,
    };
    this.audit(gate, `exec: ${input.command}`, {
      tool: input.tool,
      command: input.command.slice(0, 2000),
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      aborted: r.aborted,
      durationMs: Date.now() - startedAt,
    }, r.exitCode === 0 ? 'info' : 'warn');
    // What a command changed is unknown: the whole workspace.
    return { result, changedPaths: ['.'] };
  }

  private async buildPreview(input: WsInput, gate: WorkspaceFsGateResult): Promise<WsPreview> {
    switch (input.tool) {
      case 'ws_write': {
        const limits = await this.fsLimits();
        WorkspaceAgentTools.assertContentFits(input.content, limits);
        const current = await WorkspaceAgentTools.readOrNull(gate, input.path, limits);
        const baseHash = current?.hash ?? null;
        if (input.baseHash !== undefined && input.baseHash !== baseHash) {
          throw new ToolInputError(CONFLICT_MESSAGE.args);
        }
        return { kind: 'file', path: input.path, before: current?.content ?? null, after: input.content, baseHash };
      }
      case 'ws_edit': {
        const limits = await this.fsLimits();
        const current = await gate.backend.readText(input.path, limits);
        if (input.baseHash !== undefined && input.baseHash !== current.hash) {
          throw new ToolInputError(CONFLICT_MESSAGE.args);
        }
        const after = replaceOnce(current.content, input.oldText, input.newText);
        WorkspaceAgentTools.assertContentFits(after, limits);
        return { kind: 'file', path: input.path, before: current.content, after, baseHash: current.hash };
      }
      case 'ws_mkdir':
      case 'ws_delete':
        return { kind: 'paths', path: input.path };
      case 'ws_move':
        return { kind: 'paths', from: input.from, to: input.to };
      case 'ws_exec': {
        const conn = gate.connection;
        const cwd = conn
          ? `${conn.username}@${conn.host}:${gate.ws.remotePath ?? ''}`
          : `/workspaces/${gate.ws._id.toString()}`;
        const credentials = !conn && gate.ws.agentCredentials === true;
        return { kind: 'command', command: input.command, timeoutSec: input.timeoutSec, cwd, credentials };
      }
      default:
        throw new ToolInputError(`${input.tool} is read-only and needs no preview`);
    }
  }
}
