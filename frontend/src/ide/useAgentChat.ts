import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  ApiError,
  type AgentAllowSuggestion,
  type ChatContextRef,
  type ChatMessage,
  type ChatResponseMetrics,
  type ChatSession,
  type ChatStreamHandlers,
  type ChatToolCallRecord,
  type WsPreview,
} from '../api/client';
import type { StreamingPhase } from '../components/ChatDock';
import { errorMessage, isRecord, optionOr } from '../lib/narrow';
import { codeRefLabel, type ChatCodeRef } from './code-refs';
import { useIdeStore } from './ide-store';

const PHASES = ['queued', 'context', 'thinking', 'tool_call', 'responding'] as const satisfies readonly StreamingPhase[];

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
  success?: boolean;
  summary?: string;
  result?: string;
}

export interface AgentStreaming {
  content: string;
  contextRefs: ChatContextRef[];
  toolCalls: AgentToolCall[];
  phase: StreamingPhase;
  activeToolName?: string;
  metrics?: ChatResponseMetrics;
}

/** A writing tool call the server paused on; answered through `decide`. */
export interface AgentProposal {
  sessionId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  preview?: WsPreview;
  allowSuggestions: AgentAllowSuggestion[];
}

/** Where the conversation lives. Kept as input so a later app-wide chat can pass its own. */
export interface AgentChatContext {
  projectId: string;
  workspaceId: string;
}

export interface AgentChatHooks {
  /** A resumed turn stored an "always allow" entry (the workspace record changed). */
  onAllowListChanged?: () => void;
  /** A turn ended (done, error, stop); the agent may have changed the workspace. */
  onTurnEnd?: () => void;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function toRecords(calls: AgentToolCall[]): ChatToolCallRecord[] | undefined {
  if (calls.length === 0) return undefined;
  return calls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
    success: tc.success ?? false,
    error: tc.success === false ? tc.summary : undefined,
    ...(tc.result !== undefined ? { result: tc.result } : {}),
  }));
}

/*
 * Stored messages carry no id. A client key per message object keeps list items (and an
 * opened command output) in place; the swap to the stored copy hands the keys over.
 */
const messageKeys = new WeakMap<ChatMessage, string>();
let nextMessageKey = 1;

export function messageKey(message: ChatMessage): string {
  let key = messageKeys.get(message);
  if (!key) {
    key = `m${nextMessageKey++}`;
    messageKeys.set(message, key);
  }
  return key;
}

function adoptKeys(from: ChatMessage[], to: ChatMessage[]): void {
  to.forEach((m, i) => {
    const previous = from[i];
    if (previous && !messageKeys.has(m)) messageKeys.set(m, messageKey(previous));
  });
}

/**
 * Chat of the IDE agent: always the server path (ws_* never run in the browser),
 * the session is bound to the workspace, writing calls pause for a decision.
 */
export function useAgentChat(context: AgentChatContext, hooks: AgentChatHooks = {}) {
  const { t } = useTranslation();
  const { projectId, workspaceId } = context;
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreamingState] = useState<AgentStreaming | null>(null);
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Local system lines (expired proposal, stop), shown after the conversation until the next send. */
  const [notes, setNotes] = useState<string[]>([]);

  const streamRef = useRef<AgentStreaming | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Set by `tool_confirm`: the stream that ends next is paused, not finished. */
  const pausedRef = useRef(false);
  /** The assistant message of a turn that just finished, to swap for the stored one. */
  const finishedRef = useRef<{ sessionId: string; message: ChatMessage } | null>(null);
  const hooksRef = useRef(hooks);
  // Read by the session-resume effect, which must not rerun on a language switch.
  const tRef = useRef(t);
  useEffect(() => {
    hooksRef.current = hooks;
    tRef.current = t;
  });
  /** Id of the decision being sent (0 = none): a double submit must not send two resumes. */
  const decidingRef = useRef(0);
  const decisionSeq = useRef(0);

  const setStreaming = useCallback((next: AgentStreaming | null | ((s: AgentStreaming) => AgentStreaming)) => {
    const value = typeof next === 'function' ? (streamRef.current ? next(streamRef.current) : null) : next;
    streamRef.current = value;
    setStreamingState(value);
  }, []);

  // Resume the last session of this workspace.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await api.chat.listSessions({ projectId, workspaceId });
        const last = list[0];
        const full = last ? await api.chat.getSession(last._id) : null;
        if (alive) setSession(full);
      } catch (err) {
        if (alive) setError(errorMessage(err, tRef.current('common.error')));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, workspaceId]);

  // Closing the IDE ends a running turn (and with it a running ws_exec).
  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * After a finished turn: take the stored messages, which carry the full tool results
   * (command output). Only when the server holds exactly what is shown locally — a turn
   * whose answer had no text is not stored, its local copy stays.
   */
  const syncFromServer = useCallback(async (sessionId: string, last: ChatMessage) => {
    try {
      const stored = await api.chat.getSession(sessionId);
      setSession((prev) => {
        // Nothing happened locally meanwhile, and the server holds the same number of messages.
        if (!prev || prev._id !== sessionId || prev.messages[prev.messages.length - 1] !== last) return prev;
        if (stored.messages.length !== prev.messages.length) return prev;
        adoptKeys(prev.messages, stored.messages);
        return stored;
      });
    } catch {
      /* the local copy stays */
    }
  }, []);

  /** Ends the turn: the streamed state becomes an assistant message. */
  const finish = useCallback((sessionId: string, suffix = '') => {
    const s = streamRef.current;
    setStreaming(null);
    setProposal(null);
    pausedRef.current = false;
    if (s && (s.content.trim() || s.toolCalls.length > 0)) {
      const message: ChatMessage = {
        role: 'assistant',
        content: s.content.trim() ? s.content + suffix : s.content,
        timestamp: new Date().toISOString(),
        contextUsed: s.contextRefs.length > 0 ? s.contextRefs : undefined,
        toolCalls: toRecords(s.toolCalls),
        metrics: s.metrics,
      };
      setSession((prev) => (prev && prev._id === sessionId ? { ...prev, messages: [...prev.messages, message] } : prev));
      // A stopped turn is stored by the server only partly; keep the local copy then.
      finishedRef.current = suffix ? null : { sessionId, message };
    }
    hooksRef.current.onTurnEnd?.();
  }, [setStreaming]);

  const handlers = useCallback((sessionId: string, onFirstEvent?: () => void): ChatStreamHandlers => {
    let first = onFirstEvent;
    const touch = (): void => {
      if (!first) return;
      const cb = first;
      first = undefined;
      cb();
    };
    return {
      onContext: (refs) => {
        touch();
        setStreaming((s) => ({ ...s, contextRefs: refs, phase: 'context' }));
      },
      onStatus: (status) => {
        touch();
        setStreaming((s) => ({ ...s, phase: optionOr(status.phase, PHASES, 'thinking'), activeToolName: status.name }));
      },
      onToken: (token) => {
        touch();
        setStreaming((s) => ({ ...s, content: s.content + token, phase: 'responding', activeToolName: undefined }));
      },
      onToolCall: (call) => {
        touch();
        setStreaming((s) => ({
          ...s,
          phase: 'tool_call',
          activeToolName: call.name,
          toolCalls: s.toolCalls.some((tc) => tc.id === call.id)
            ? s.toolCalls
            : [...s.toolCalls, { id: call.id, name: call.name, arguments: call.arguments }],
        }));
      },
      onToolResult: (result) => {
        touch();
        setStreaming((s) => ({
          ...s,
          toolCalls: s.toolCalls.map((tc) =>
            tc.id === result.id
              ? { ...tc, success: result.success, summary: result.summary, ...(result.result !== undefined ? { result: result.result } : {}) }
              : tc,
          ),
        }));
      },
      onToolConfirm: (call) => {
        touch();
        pausedRef.current = true;
        // A new card can be answered even before this stream has closed.
        decidingRef.current = 0;
        // Listed right away: a rejection only sends the result, no `tool_call`.
        setStreaming((s) => ({
          ...s,
          phase: 'tool_call',
          activeToolName: call.name,
          toolCalls: s.toolCalls.some((tc) => tc.id === call.id)
            ? s.toolCalls
            : [...s.toolCalls, { id: call.id, name: call.name, arguments: call.arguments }],
        }));
        setProposal({
          sessionId,
          callId: call.id,
          name: call.name,
          args: parseArgs(call.arguments),
          preview: call.preview,
          allowSuggestions: call.allowSuggestions ?? [],
        });
      },
      onWorkspaceChanged: (paths) => {
        touch();
        useIdeStore.getState().applyWorkspaceChanged(paths);
      },
      onMetrics: (metrics) => {
        touch();
        setStreaming((s) => ({ ...s, metrics }));
      },
      onDone: () => finish(sessionId),
      onError: (message) => {
        setError(message);
        finish(sessionId);
      },
    };
  }, [finish, setStreaming]);

  /** Runs one stream (new message or resume) to its end; a paused stream leaves the turn open. */
  const runStream = useCallback(async (sessionId: string, abort: AbortController, run: () => Promise<void>) => {
    try {
      await run();
      // Closed without `done`/`error` and not paused: still end the turn.
      if (!pausedRef.current && streamRef.current && abortRef.current === abort) finish(sessionId);
      // The server stores the answer after `done` and closes the stream after that.
      const finished = finishedRef.current;
      finishedRef.current = null;
      if (finished && finished.sessionId === sessionId) void syncFromServer(sessionId, finished.message);
    } catch (err) {
      if (isAbortError(err) || abort.signal.aborted) return;
      if (err instanceof ApiError && err.status === 404 && err.code === 'proposal_expired') {
        setNotes((n) => [...n, t('ide.agent.proposalExpired')]);
      } else {
        setError(errorMessage(err, t('common.error')));
      }
      finish(sessionId);
      finishedRef.current = null;
    } finally {
      // A paused turn keeps its controller: the resume runs under it, Stop aborts it.
      if (abortRef.current === abort && !pausedRef.current) abortRef.current = null;
    }
  }, [finish, syncFromServer, t]);

  const send = useCallback(async (content: string, agentRoleId?: string, codeRefs?: ChatCodeRef[]): Promise<boolean> => {
    const text = content.trim();
    const refs = codeRefs && codeRefs.length > 0 ? codeRefs : undefined;
    if ((!text && !refs) || streamRef.current) return false;
    setError(null);
    setNotes([]);
    let current = session;
    if (!current) {
      try {
        current = await api.chat.createSession({ projectId }, (text || (refs ? codeRefLabel(refs[0]) : '')).slice(0, 60), { workspaceId, ideAgent: true });
        setSession(current);
      } catch (err) {
        setError(errorMessage(err, t('common.error')));
        return false;
      }
    }
    const sessionId = current._id;
    const userMessage: ChatMessage = { role: 'user', content: text, timestamp: new Date().toISOString(), ...(refs ? { codeRefs: refs } : {}) };
    setSession((prev) => (prev && prev._id === sessionId ? { ...prev, messages: [...prev.messages, userMessage] } : prev));
    const abort = new AbortController();
    abortRef.current = abort;
    pausedRef.current = false;
    setStreaming({ content: '', contextRefs: [], toolCalls: [], phase: 'queued' });
    await runStream(sessionId, abort, () =>
      api.chat.streamMessage(sessionId, text, undefined, handlers(sessionId), abort.signal, undefined, undefined, agentRoleId, refs),
    );
    return true;
  }, [session, projectId, workspaceId, handlers, runStream, setStreaming, t]);

  /** Answers the open proposal; `alwaysAllow` must be one of its `allowSuggestions`. */
  const decide = useCallback(async (approved: boolean, alwaysAllow?: AgentAllowSuggestion): Promise<void> => {
    const p = proposal;
    if (!p || decidingRef.current !== 0) return;
    const decision = ++decisionSeq.current;
    decidingRef.current = decision;
    setProposal(null);
    pausedRef.current = false;
    setError(null);
    const abort = abortRef.current && !abortRef.current.signal.aborted ? abortRef.current : new AbortController();
    abortRef.current = abort;
    setStreaming((s) => ({ ...s, phase: 'tool_call', activeToolName: p.name }));
    const onFirst = alwaysAllow ? () => hooksRef.current.onAllowListChanged?.() : undefined;
    try {
      await runStream(p.sessionId, abort, () =>
        api.chat.resumeTool(
          p.sessionId,
          { callId: p.callId, approved, ...(approved && alwaysAllow ? { alwaysAllow } : {}) },
          handlers(p.sessionId, onFirst),
          abort.signal,
        ),
      );
    } finally {
      if (decidingRef.current === decision) decidingRef.current = 0;
    }
  }, [proposal, handlers, runStream, setStreaming]);

  const stop = useCallback(() => {
    const sessionId = session?._id;
    abortRef.current?.abort();
    abortRef.current = null;
    if (sessionId) finish(sessionId, ' …');
    else {
      setStreaming(null);
      setProposal(null);
      pausedRef.current = false;
    }
  }, [session, finish, setStreaming]);

  const newConversation = useCallback(() => {
    if (streamRef.current) return;
    setSession(null);
    setError(null);
    setNotes([]);
  }, []);

  return {
    session,
    messages: session?.messages ?? [],
    loading,
    streaming,
    proposal,
    error,
    notes,
    busy: streaming !== null,
    send,
    decide,
    stop,
    newConversation,
    clearError: () => setError(null),
  };
}
