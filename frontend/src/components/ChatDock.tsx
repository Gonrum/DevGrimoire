import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  api,
  ChatAttachmentRef,
  ChatContextRef,
  ChatMessage,
  ChatResponseMetrics,
  ChatSession,
  ChatToolCallRecord,
  Project,
  UserLlmConfig,
  Workspace,
} from '../api/client';
import { streamBrowserLlm, BrowserLlmMessage } from '../api/browserLlmClient';
import Markdown from './Markdown';
import Button from './ui/Button';

const LAST_SESSION_KEY_PREFIX = 'devgrimoire_chat_last_session:';
const LAST_WORKSPACE_KEY_PREFIX = 'devgrimoire_chat_last_workspace:';
const DOCK_WIDTH_KEY = 'devgrimoire_chat_dock_width';
const DOCK_DEFAULT_WIDTH = 440;
const DOCK_MIN_WIDTH = 320;

function loadDockWidth(): number {
  if (typeof window === 'undefined') return DOCK_DEFAULT_WIDTH;
  const stored = localStorage.getItem(DOCK_WIDTH_KEY);
  const n = stored ? parseInt(stored, 10) : NaN;
  return Number.isFinite(n) && n >= DOCK_MIN_WIDTH ? n : DOCK_DEFAULT_WIDTH;
}

interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
  success?: boolean;
  summary?: string;
}

type StreamingPhase = 'queued' | 'context' | 'thinking' | 'tool_call' | 'responding';

interface StreamingState {
  content: string;
  contextRefs: ChatContextRef[];
  toolCalls: StreamingToolCall[];
  phase: StreamingPhase;
  activeToolName?: string;
  metrics?: ChatResponseMetrics;
  /** Browser-mode timestamps so we can build metrics locally on persist. */
  browserStartMs?: number;
  browserFirstTokenMs?: number;
}

interface PendingAttachment {
  /** Stable local id while the upload is in flight. */
  tempId: string;
  file: File;
  status: 'uploading' | 'ready' | 'error';
  /** ID assigned by the backend after successful upload. */
  attachmentId?: string;
  error?: string;
  /** For image previews — object URL, revoked on removal / send. */
  objectUrl?: string;
}

const CHAT_ATTACHMENT_ACCEPT =
  '.md,.txt,.json,.csv,.xml,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.py,.go,.rs,.sh,.bash,.java,.c,.cpp,.h,.hpp,.cs,.php,.rb,.sql,.graphql,.svelte,.vue,.prisma,.ini,.cfg,.html,.css,.pdf,text/*,application/json,application/pdf,application/x-yaml,image/jpeg,image/png,image/webp,image/gif';

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

function streamingStatusKey(phase: StreamingPhase): string {
  switch (phase) {
    case 'context': return 'chat.streamContext';
    case 'tool_call': return 'chat.streamToolCall';
    case 'responding': return 'chat.streamResponding';
    case 'thinking': return 'chat.streamThinking';
    default: return 'chat.streamQueued';
  }
}

/**
 * Normalize a tool-call `arguments` string before replaying it to the LLM
 * (browser-mode). Mirrors the same helper in the backend controller — some
 * providers (Ollama Cloud) strictly re-validate the assistant's previous
 * tool_call on the next iteration and 400 on streaming-accumulator artefacts.
 * Returns `"{}"` on unparseable input so replay never crashes.
 */
function canonicalizeJsonArgs(raw: string | undefined | null): string {
  if (!raw || !raw.trim()) return '{}';
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return '{}';
  }
}

/** Max per-file size check (client-side — final check is server-side). */
const CHAT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

function getProjectIdFromPath(pathname: string): string | null {
  const match = matchPath('/projects/:id/*', pathname) ?? matchPath('/projects/:id', pathname);
  const id = match?.params?.id;
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id) ? id : null;
}

function getCustomerIdFromPath(pathname: string): string | null {
  const match = matchPath('/customers/:id/*', pathname) ?? matchPath('/customers/:id', pathname);
  const id = match?.params?.id;
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id) ? id : null;
}

export default function ChatDock() {
  const { t } = useTranslation();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [featureEnabled, setFeatureEnabled] = useState<boolean>(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [userLlm, setUserLlm] = useState<UserLlmConfig | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [retryDraft, setRetryDraft] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --- Attachments (M-10 text, M-11 images) ---
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  // Cache whether any configured endpoint is vision-capable (for the no-vision banner).
  const [visionAvailable, setVisionAvailable] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.chat.getConfig().then((cfg) => {
      if (cancelled) return;
      setVisionAvailable(cfg.endpoints.some((e) => e.visionCapable));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  const hasPendingImage = pendingAttachments.some((p) => isImageFile(p.file));
  const noVisionBanner = hasPendingImage && !visionAvailable;

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const currentSessionId = session?._id;
      if (!currentSessionId) return;
      const list = Array.from(files);
      for (const file of list) {
        const tempId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const objectUrl = isImageFile(file) ? URL.createObjectURL(file) : undefined;
        if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          setPendingAttachments((prev) => [
            ...prev,
            { tempId, file, status: 'error', error: t('chat.attachTooLarge') },
          ]);
          continue;
        }
        setPendingAttachments((prev) => [...prev, { tempId, file, status: 'uploading', objectUrl }]);
        try {
          const res = await api.chat.uploadAttachment(currentSessionId, file);
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.tempId === tempId ? { ...p, status: 'ready', attachmentId: res.id } : p,
            ),
          );
        } catch (err) {
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.tempId === tempId
                ? { ...p, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
                : p,
            ),
          );
        }
      }
    },
    [session?._id, t],
  );

  const removePendingAttachment = useCallback((tempId: string) => {
    setPendingAttachments((prev) => {
      const removed = prev.find((p) => p.tempId === tempId);
      if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
      return prev.filter((p) => p.tempId !== tempId);
    });
  }, []);

  // Clear pending attachments when the active session changes — they're session-scoped on the server.
  useEffect(() => {
    setPendingAttachments((prev) => {
      prev.forEach((p) => p.objectUrl && URL.revokeObjectURL(p.objectUrl));
      return [];
    });
  }, [session?._id]);

  const [dockWidth, setDockWidth] = useState<number>(loadDockWidth);
  const [resizing, setResizing] = useState(false);
  const resizingRef = useRef(false);

  // Resize logic — only applied on sm+ (Mobile bleibt full-width)
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const vw = window.innerWidth;
      const max = Math.floor(vw * 0.8);
      const next = Math.min(Math.max(vw - e.clientX, DOCK_MIN_WIDTH), max);
      setDockWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      setResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  // Persist width (debounced via effect on commit)
  useEffect(() => {
    if (resizing) return;
    localStorage.setItem(DOCK_WIDTH_KEY, String(dockWidth));
  }, [dockWidth, resizing]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    setResizing(true);
  };

  const resetWidth = () => {
    setDockWidth(DOCK_DEFAULT_WIDTH);
  };

  const contextProjectId = useMemo(() => getProjectIdFromPath(location.pathname), [location.pathname]);
  const contextCustomerId = useMemo(() => getCustomerIdFromPath(location.pathname), [location.pathname]);

  // Auto-pick project/customer from URL or first project in list
  useEffect(() => {
    if (!open) return;
    if (contextCustomerId && contextCustomerId !== customerId) {
      setCustomerId(contextCustomerId);
      setProjectId(null);
      return;
    }
    if (projectId || customerId) return;
    if (contextProjectId) {
      setProjectId(contextProjectId);
    } else if (projects.length > 0) {
      setProjectId(projects[0]._id);
    }
  }, [open, contextProjectId, contextCustomerId, projects, projectId, customerId]);

  // When URL changes to a different project/customer page, switch dock context
  useEffect(() => {
    if (contextCustomerId && contextCustomerId !== customerId) {
      setCustomerId(contextCustomerId);
      setProjectId(null);
      return;
    }
    if (!contextCustomerId && customerId) {
      // Left customer-detail page → fall back to project mode
      setCustomerId(null);
    }
    if (contextProjectId && contextProjectId !== projectId) {
      setProjectId(contextProjectId);
    }
  }, [contextProjectId, contextCustomerId, projectId, customerId]);

  // Fetch feature-enabled flag eagerly so we can hide the floating button
  // when an admin has globally disabled chat.
  useEffect(() => {
    api.chat.getConfig()
      .then((cfg) => {
        setFeatureEnabled(cfg.enabled !== false);
        setConfigured((cfg.endpoints?.length ?? 0) > 0);
      })
      .catch(() => setFeatureEnabled(false));
  }, []);

  // Fetch profile + project list when opening
  useEffect(() => {
    if (!open) return;
    api.profile.get()
      .then((p) => setUserLlm(p.llmConfig ?? null))
      .catch(() => setUserLlm(null));
    if (projects.length === 0) {
      api.projects.list({ active: true })
        .then(setProjects)
        .catch(() => setProjects([]));
    }
  }, [open, projects.length]);

  // Load sessions for selected project/customer
  const loadSessions = useCallback(async (owner: { projectId?: string | null; customerId?: string | null }) => {
    setLoadingSessions(true);
    try {
      const list = await api.chat.listSessions({
        projectId: owner.projectId || undefined,
        customerId: owner.customerId || undefined,
      });
      setSessions(list);
      return list;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading sessions');
      return [];
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  // Load active workspaces for the selected project + restore the last
  // explicitly-picked workspace from localStorage. Switching projects
  // resets the active workspace so a stale id never leaks across projects.
  useEffect(() => {
    if (!projectId) {
      setWorkspaces([]);
      setActiveWorkspaceId(null);
      return;
    }
    let cancelled = false;
    api.workspaces
      .list(projectId, 'active')
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(list);
        const stored = typeof window !== 'undefined'
          ? window.localStorage.getItem(LAST_WORKSPACE_KEY_PREFIX + projectId)
          : null;
        const valid = stored && list.some((w) => w._id === stored) ? stored : null;
        setActiveWorkspaceId(valid);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaces([]);
        setActiveWorkspaceId(null);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const setActiveWorkspaceWithPersist = useCallback((wsId: string | null) => {
    setActiveWorkspaceId(wsId);
    if (typeof window === 'undefined' || !projectId) return;
    if (wsId) window.localStorage.setItem(LAST_WORKSPACE_KEY_PREFIX + projectId, wsId);
    else window.localStorage.removeItem(LAST_WORKSPACE_KEY_PREFIX + projectId);
  }, [projectId]);

  // Load detailed session with messages
  const loadSession = useCallback(async (id: string) => {
    setLoadingSession(true);
    try {
      const s = await api.chat.getSession(id);
      setSession(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading session');
    } finally {
      setLoadingSession(false);
    }
  }, []);

  // When project/customer changes: load sessions and restore last session
  useEffect(() => {
    if (!open) return;
    if (!projectId && !customerId) return;
    setSession(null);
    const ownerKey = projectId || `c:${customerId}`;
    loadSessions({ projectId, customerId }).then((list) => {
      const lastId = localStorage.getItem(LAST_SESSION_KEY_PREFIX + ownerKey);
      const target = list.find((s) => s._id === lastId) ?? list[0];
      if (target) {
        loadSession(target._id);
      }
    });
  }, [open, projectId, customerId, loadSessions, loadSession]);

  // Persist selected session per owner
  useEffect(() => {
    const ownerKey = projectId || (customerId ? `c:${customerId}` : null);
    if (ownerKey && session?._id) {
      localStorage.setItem(LAST_SESSION_KEY_PREFIX + ownerKey, session._id);
    }
  }, [projectId, customerId, session?._id]);

  // Auto-scroll on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages?.length, streaming?.content]);

  // Keyboard: ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !streaming) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, streaming]);

  // Cancel stream when dock closes or project changes
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const createNewSession = useCallback(async () => {
    if (!projectId && !customerId) return;
    try {
      const owner = { projectId: projectId || undefined, customerId: customerId || undefined };
      const created = await api.chat.createSession(owner);
      const list = await loadSessions(owner);
      setSessions(list);
      await loadSession(created._id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error creating session');
    }
  }, [projectId, customerId, loadSessions, loadSession]);

  const deleteCurrentSession = useCallback(async () => {
    if (!session) return;
    try {
      await api.chat.deleteSession(session._id);
      setSession(null);
      if (projectId || customerId) {
        const list = await loadSessions({ projectId, customerId });
        if (list[0]) await loadSession(list[0]._id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error deleting');
    }
  }, [session, projectId, customerId, loadSessions, loadSession]);

  const runServerStream = useCallback(
    async (
      sessionId: string,
      content: string,
      attachmentIds: string[] | undefined,
      abort: AbortController,
    ) => {
      await api.chat.streamMessage(
        sessionId,
        content,
        attachmentIds,
        {
          onContext: (refs) => {
            setStreaming((s) => s ? { ...s, contextRefs: refs, phase: 'context' } : s);
          },
          onStatus: (status) => {
            const phase = ['queued', 'context', 'thinking', 'tool_call', 'responding'].includes(status.phase)
              ? status.phase as StreamingPhase
              : 'thinking';
            setStreaming((s) => s ? { ...s, phase, activeToolName: status.name } : s);
          },
          onToken: (token) => {
            setStreaming((s) => s ? { ...s, content: s.content + token, phase: 'responding', activeToolName: undefined } : s);
          },
          onToolCall: (call) => {
            setStreaming((s) => s ? {
              ...s,
              phase: 'tool_call',
              activeToolName: call.name,
              toolCalls: [...s.toolCalls, { id: call.id, name: call.name, arguments: call.arguments }],
            } : s);
          },
          onToolResult: (result) => {
            setStreaming((s) => s ? {
              ...s,
              toolCalls: s.toolCalls.map((tc) =>
                tc.id === result.id ? { ...tc, success: result.success, summary: result.summary } : tc,
              ),
            } : s);
          },
          onMetrics: (metrics) => {
            setStreaming((s) => s ? { ...s, metrics } : s);
          },
          onDone: () => {
            setStreaming((s) => {
              if (!s) return null;
              const toolCallRecords: ChatToolCallRecord[] | undefined = s.toolCalls.length > 0
                ? s.toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: tc.arguments,
                    success: tc.success ?? false,
                    error: tc.success === false ? tc.summary : undefined,
                  }))
                : undefined;
              const assistantMsg: ChatMessage = {
                role: 'assistant',
                content: s.content,
                timestamp: new Date().toISOString(),
                contextUsed: s.contextRefs.length > 0 ? s.contextRefs : undefined,
                toolCalls: toolCallRecords,
                metrics: s.metrics,
              };
              setSession((prev) => prev ? { ...prev, messages: [...prev.messages, assistantMsg] } : prev);
              return null;
            });
          },
          onError: (message) => {
            setError(message);
            setRetryDraft(content);
            setStreaming(null);
          },
        },
        abort.signal,
        activeWorkspaceId,
      );
    },
    [activeWorkspaceId],
  );

  const runBrowserStream = useCallback(
    async (
      sessionId: string,
      content: string,
      attachmentIds: string[] | undefined,
      abort: AbortController,
      llm: UserLlmConfig,
    ) => {
      if (!llm.endpoint?.trim() || !llm.model?.trim()) {
        throw new Error(t('chat.browserMissingConfig'));
      }
      setStreaming((s) => s ? { ...s, phase: 'context' } : s);
      const prep = await api.chat.prepareMessage(sessionId, content, attachmentIds, activeWorkspaceId);
      const requestStart = Date.now();
      let firstTokenTs: number | null = null;
      setStreaming((s) => s ? { ...s, contextRefs: prep.contextRefs, phase: 'thinking', browserStartMs: requestStart } : s);

      const conversation: BrowserLlmMessage[] = prep.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      let fullResponse = '';
      const persistedToolCalls: ChatToolCallRecord[] = [];
      const maxIter = prep.toolsEnabled ? Math.max(1, prep.toolsMaxIterations) : 1;

      for (let iter = 0; iter < maxIter; iter++) {
        if (abort.signal.aborted) break;
        const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let iterContent = '';
        let finishReason: 'stop' | 'tool_calls' | 'length' | 'other' = 'other';

        for await (const event of streamBrowserLlm({
          endpoint: llm.endpoint,
          model: llm.model,
          apiKey: llm.apiKey,
          messages: conversation,
          tools: prep.tools,
          temperature: prep.temperature,
          maxTokens: prep.maxTokens,
          signal: abort.signal,
        })) {
          if (abort.signal.aborted) break;
          if (event.type === 'token') {
            if (firstTokenTs === null) firstTokenTs = Date.now();
            iterContent += event.content;
            fullResponse += event.content;
            setStreaming((s) => s ? {
              ...s,
              content: s.content + event.content,
              phase: 'responding',
              activeToolName: undefined,
              browserFirstTokenMs: s.browserFirstTokenMs ?? firstTokenTs ?? undefined,
            } : s);
          } else if (event.type === 'tool_call') {
            pendingToolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
          } else if (event.type === 'finish') {
            finishReason = event.reason;
          }
        }

        if (abort.signal.aborted) break;
        if (finishReason !== 'tool_calls' || pendingToolCalls.length === 0) break;

        // Assistant turn carrying the tool_calls (content may be empty).
        // Canonicalize arguments so strict providers don't 400 on iteration 2.
        conversation.push({
          role: 'assistant',
          content: iterContent,
          tool_calls: pendingToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: canonicalizeJsonArgs(tc.arguments) },
          })),
        });

        for (const tc of pendingToolCalls) {
          if (abort.signal.aborted) break;
          setStreaming((s) => s ? {
            ...s,
            phase: 'tool_call',
            activeToolName: tc.name,
            toolCalls: [...s.toolCalls, { id: tc.id, name: tc.name, arguments: tc.arguments }],
          } : s);

          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
          } catch {
            parsedArgs = {};
          }
          const result = await api.chat.executeTool(sessionId, {
            name: tc.name,
            projectId: prep.projectId,
            arguments: parsedArgs,
          });
          setStreaming((s) => s ? {
            ...s,
            toolCalls: s.toolCalls.map((tcUi) =>
              tcUi.id === tc.id ? { ...tcUi, success: result.success, summary: result.summary } : tcUi,
            ),
          } : s);
          conversation.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.name,
            content: result.content,
          });
          persistedToolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            result: result.content,
            success: result.success,
            error: result.error,
          });
        }
      }

      if (abort.signal.aborted) return;

      const endTs = Date.now();
      const metrics: ChatResponseMetrics | undefined = fullResponse.trim()
        ? (() => {
            const outputTokens = Math.max(1, Math.round(fullResponse.length / 4));
            const durationMs = Math.max(1, endTs - requestStart);
            const firstTokenMs = firstTokenTs != null ? firstTokenTs - requestStart : undefined;
            const generationMs = firstTokenMs != null ? Math.max(1, durationMs - firstTokenMs) : durationMs;
            const tokensPerSecond = Math.round((outputTokens / generationMs) * 1000 * 10) / 10;
            return {
              outputTokens,
              durationMs,
              firstTokenMs,
              tokensPerSecond,
              totalDurationMs: persistedToolCalls.length > 0 ? durationMs : undefined,
              estimated: true,
            };
          })()
        : undefined;

      if (fullResponse.trim()) {
        await api.chat.persistMessage(sessionId, {
          userContent: content,
          assistantContent: fullResponse,
          contextRefs: prep.contextRefs,
          toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : undefined,
          attachmentIds,
          metrics,
          browserEndpointUrl: llm.endpoint,
          browserModel: llm.model,
        });
        setStreaming((s) => {
          if (!s) return null;
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: s.content,
            timestamp: new Date().toISOString(),
            contextUsed: s.contextRefs.length > 0 ? s.contextRefs : undefined,
            toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : undefined,
            metrics,
          };
          setSession((prev) => prev ? { ...prev, messages: [...prev.messages, assistantMsg] } : prev);
          return null;
        });
      } else {
        // Persist the user message even if the assistant produced nothing,
        // so it stays in the session.
        await api.chat.persistMessage(sessionId, {
          userContent: content,
          attachmentIds,
          browserEndpointUrl: llm.endpoint,
          browserModel: llm.model,
        });
        setStreaming(null);
      }
    },
    [t, activeWorkspaceId],
  );

  const sendMessage = useCallback(async () => {
    if (!session || !draft.trim() || streaming) return;
    // Block send while any upload is still in flight — avoids racing against
    // an attachment that isn't persisted yet.
    if (pendingAttachments.some((p) => p.status === 'uploading')) {
      setError(t('chat.attachUploadInProgress'));
      return;
    }
    const content = draft.trim();
    const readyAttachments = pendingAttachments.filter((p) => p.status === 'ready' && p.attachmentId);
    const attachmentIds = readyAttachments.map((p) => p.attachmentId as string);
    const attachmentRefsForUi: ChatAttachmentRef[] | undefined = readyAttachments.length > 0
      ? readyAttachments.map((p) => ({
          attachmentId: p.attachmentId as string,
          fileName: p.file.name,
          size: p.file.size,
          kind: isImageFile(p.file) ? 'image' : 'text',
        }))
      : undefined;

    setDraft('');
    setError(null);
    setRetryDraft(null);
    setFallbackNotice(null);
    setPendingAttachments((prev) => {
      prev.forEach((p) => p.objectUrl && URL.revokeObjectURL(p.objectUrl));
      return [];
    });

    // Optimistically append user message
    const userMsg: ChatMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      attachments: attachmentRefsForUi,
    };
    setSession((prev) => prev ? { ...prev, messages: [...prev.messages, userMsg] } : prev);

    const abort = new AbortController();
    abortRef.current = abort;
    setStreaming({ content: '', contextRefs: [], toolCalls: [], phase: 'queued', browserStartMs: Date.now() });

    const useBrowserMode = userLlm?.mode === 'browser';
    const fallbackAllowed = !!userLlm?.fallbackEnabled;
    const outgoingAttachmentIds = attachmentIds.length > 0 ? attachmentIds : undefined;

    try {
      if (useBrowserMode && userLlm) {
        try {
          await runBrowserStream(session._id, content, outgoingAttachmentIds, abort, userLlm);
        } catch (err) {
          if ((err as Error).name === 'AbortError' || abort.signal.aborted) {
            throw err;
          }
          if (!fallbackAllowed) {
            throw err;
          }
          // Reset streaming state and replay against the server-side LLM
          const detail = err instanceof Error ? err.message : String(err);
          setFallbackNotice(`${t('chat.browserFallbackUsed')} (${detail})`);
          setStreaming({ content: '', contextRefs: [], toolCalls: [], phase: 'queued', browserStartMs: Date.now() });
          await runServerStream(session._id, content, outgoingAttachmentIds, abort);
        }
      } else {
        await runServerStream(session._id, content, outgoingAttachmentIds, abort);
      }
      if (projectId || customerId) {
        loadSessions({ projectId, customerId }).catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Stream failed');
        setRetryDraft(content);
      }
      setStreaming(null);
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, [session, draft, streaming, projectId, customerId, loadSessions, userLlm, runBrowserStream, runServerStream, pendingAttachments, t]);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    setStreaming((s) => {
      if (!s) return null;
      if (s.content.trim()) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: s.content + ' …',
          timestamp: new Date().toISOString(),
          contextUsed: s.contextRefs.length > 0 ? s.contextRefs : undefined,
        };
        setSession((prev) => prev ? { ...prev, messages: [...prev.messages, assistantMsg] } : prev);
      }
      return null;
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Don't render on login page
  if (location.pathname === '/login') return null;
  // Don't render anything when the feature is globally disabled
  if (!featureEnabled) return null;

  return (
    <>
      {/* Floating Button */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 bg-violet-600 hover:bg-violet-500 text-white rounded-full shadow-lg shadow-violet-900/40 p-3 transition-transform hover:scale-105 glow-violet"
          aria-label={t('chat.open')}
          title={t('chat.open')}
          style={{ bottom: 'max(1.5rem, var(--sab))', right: 'max(1.5rem, var(--sar))' }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}

      {/* Dock */}
      <div
        className={`fixed top-0 right-0 z-50 h-full w-full bg-gray-900 border-l border-gray-800 shadow-2xl flex flex-col ${
          resizing ? '' : 'transition-transform duration-200'
        } ${open ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
        style={{
          paddingTop: 'var(--sat)',
          paddingBottom: 'var(--sab)',
          // Only apply explicit width on sm+ screens — rely on Tailwind responsive via max-width
          maxWidth: '100%',
          width: `min(100%, ${dockWidth}px)`,
        }}
        aria-hidden={!open}
      >
        {/* Resize handle (desktop only) */}
        <div
          className="hidden sm:block absolute top-0 left-0 h-full w-1.5 cursor-col-resize group hover:bg-violet-600/30 z-10"
          onMouseDown={startResize}
          onDoubleClick={resetWidth}
          title={t('chat.resize')}
          aria-label={t('chat.resize')}
        >
          <div className="w-px h-full mx-auto bg-gray-800 group-hover:bg-violet-500/60 transition-colors" />
        </div>
        {/* Header */}
        <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-violet-400">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <h2 className="text-sm font-semibold text-gray-200 flex-1">{t('chat.title')}</h2>
          {userLlm?.mode === 'browser' && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-300 border border-cyan-800/60"
              title={t('chat.modeBadgeTitle', { mode: t('chat.modeBrowser') })}
            >
              {t('chat.modeBrowser')}
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-gray-500 hover:text-gray-300 p-1"
            aria-label={t('common.close')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {configured === false ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-3">
            <div className="text-gray-400 text-sm">{t('chat.notConfigured')}</div>
            <Link
              to="/settings"
              onClick={() => setOpen(false)}
              className="text-cyan-400 hover:text-cyan-300 text-sm"
            >
              {t('chat.goToSettings')}
            </Link>
          </div>
        ) : (
          <>
            {/* Project + Session selectors */}
            <div className="border-b border-gray-800 px-3 py-2 flex flex-col gap-2 bg-gray-900/50">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 shrink-0 w-16">{t('chat.project')}</label>
                <select
                  value={projectId ?? ''}
                  onChange={(e) => setProjectId(e.target.value || null)}
                  className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500"
                >
                  <option value="">{t('chat.selectProject')}</option>
                  {projects.map((p) => (
                    <option key={p._id} value={p._id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 shrink-0 w-16">{t('chat.session')}</label>
                <select
                  value={session?._id ?? ''}
                  onChange={(e) => e.target.value && loadSession(e.target.value)}
                  disabled={!projectId || loadingSessions}
                  className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                >
                  {sessions.length === 0 && <option value="">{t('chat.noSessions')}</option>}
                  {sessions.map((s) => (
                    <option key={s._id} value={s._id}>{s.title}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={createNewSession}
                  disabled={!projectId}
                  className="text-xs text-cyan-400 hover:text-cyan-300 px-2 disabled:opacity-50"
                  title={t('chat.newSession')}
                >
                  +
                </button>
                {session && (
                  <button
                    type="button"
                    onClick={deleteCurrentSession}
                    className="text-xs text-red-400 hover:text-red-300 px-1"
                    title={t('common.delete')}
                  >
                    ×
                  </button>
                )}
              </div>
              {projectId && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 shrink-0 w-16">{t('chat.workspace')}</label>
                  <select
                    value={activeWorkspaceId ?? ''}
                    onChange={(e) => setActiveWorkspaceWithPersist(e.target.value || null)}
                    disabled={workspaces.length === 0}
                    className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                    title={t('chat.workspaceHint')}
                  >
                    <option value="">{t('chat.workspaceNone')}</option>
                    {workspaces.map((w) => (
                      <option key={w._id} value={w._id}>{w.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
              {!session && !loadingSession && (
                <div className="text-gray-600 text-xs text-center py-12">
                  {projectId ? t('chat.startPrompt') : t('chat.selectProjectFirst')}
                </div>
              )}
              {loadingSession && (
                <div className="text-gray-600 text-xs text-center py-12">{t('common.loading')}</div>
              )}
              {session?.messages?.filter((m) => m.role !== 'system').map((msg, idx) => (
                <MessageBubble key={idx} message={msg} />
              ))}
              {streaming && (
                <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                  {streaming.toolCalls.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {streaming.toolCalls.map((tc) => (
                        <ToolCallRow key={tc.id} call={tc} />
                      ))}
                    </div>
                  )}
                  <div className="text-gray-200 text-sm">
                    {streaming.content ? (
                      <Markdown>{streaming.content}</Markdown>
                    ) : (
                      <StreamingActivity phase={streaming.phase} activeToolName={streaming.activeToolName} />
                    )}
                  </div>
                  {streaming.metrics && <MetricsBadge metrics={streaming.metrics} />}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Fallback notice */}
            {fallbackNotice && (
              <div className="px-3 py-2 border-t border-amber-900/40 bg-amber-900/20 text-amber-200 text-xs flex items-center justify-between gap-2">
                <span className="truncate">{fallbackNotice}</span>
                <button type="button" onClick={() => setFallbackNotice(null)} className="text-amber-300 hover:text-amber-100 shrink-0">×</button>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="px-3 py-2 border-t border-red-900/40 bg-red-900/20 text-red-300 text-xs flex items-center justify-between gap-2">
                <span className="truncate">{error}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {retryDraft && (
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(retryDraft);
                        setError(null);
                        setRetryDraft(null);
                        setTimeout(() => textareaRef.current?.focus(), 0);
                      }}
                      className="text-red-200 hover:text-white underline underline-offset-2"
                    >
                      {t('chat.retry')}
                    </button>
                  )}
                  <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-200">×</button>
                </div>
              </div>
            )}

            {/* Input */}
            <div
              className={`border-t p-3 relative transition-colors ${
                dragActive ? 'border-violet-500 bg-violet-900/10' : 'border-gray-800'
              }`}
              onDragEnter={(e) => {
                if (!session || streaming) return;
                e.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(e) => {
                if (!session || streaming) return;
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the wrapper, not moving between children
                if (e.currentTarget === e.target) setDragActive(false);
              }}
              onDrop={(e) => {
                if (!session || streaming) return;
                e.preventDefault();
                setDragActive(false);
                if (e.dataTransfer.files?.length) {
                  uploadFiles(e.dataTransfer.files);
                }
              }}
            >
              {dragActive && (
                <div className="absolute inset-0 flex items-center justify-center rounded bg-violet-900/30 border-2 border-dashed border-violet-400 pointer-events-none z-10">
                  <span className="text-violet-200 text-sm">📎 {t('chat.attachDropHere')}</span>
                </div>
              )}

              {noVisionBanner && (
                <div className="mb-2 px-2 py-1.5 rounded text-xs text-amber-200 bg-amber-900/20 border border-amber-800/40">
                  ⚠ {t('chat.attachNoVisionEndpoint')}
                </div>
              )}

              {pendingAttachments.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {pendingAttachments.map((p) => {
                    const isImg = isImageFile(p.file);
                    return (
                      <div
                        key={p.tempId}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border ${
                          p.status === 'error'
                            ? 'bg-red-900/30 border-red-800 text-red-200'
                            : p.status === 'uploading'
                              ? 'bg-gray-800 border-gray-700 text-gray-400'
                              : 'bg-emerald-900/20 border-emerald-800/50 text-emerald-200'
                        }`}
                        title={p.error || `${(p.file.size / 1024).toFixed(1)} KB`}
                      >
                        {isImg && p.objectUrl ? (
                          <img
                            src={p.objectUrl}
                            alt={p.file.name}
                            className={`w-8 h-8 object-cover rounded ${p.status === 'uploading' ? 'opacity-50' : ''}`}
                          />
                        ) : (
                          <>
                            {p.status === 'uploading' && <span className="animate-pulse">⏳</span>}
                            {p.status === 'ready' && <span>📎</span>}
                            {p.status === 'error' && <span>⚠</span>}
                          </>
                        )}
                        <span className="font-mono truncate max-w-[180px]">{p.file.name}</span>
                        <button
                          type="button"
                          onClick={() => removePendingAttachment(p.tempId)}
                          className="ml-1 opacity-60 hover:opacity-100"
                          aria-label={t('chat.attachRemove')}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={CHAT_ATTACHMENT_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) uploadFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!session || !!streaming}
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('chat.attachFile')}
                  aria-label={t('chat.attachFile')}
                >
                  📎
                </button>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={(e) => {
                    if (!session || streaming) return;
                    const items = e.clipboardData?.items;
                    if (!items) return;
                    const imageFiles: File[] = [];
                    for (let i = 0; i < items.length; i++) {
                      const item = items[i];
                      if (item.kind === 'file' && item.type.startsWith('image/')) {
                        const f = item.getAsFile();
                        if (f) imageFiles.push(f);
                      }
                    }
                    if (imageFiles.length > 0) {
                      e.preventDefault();
                      uploadFiles(imageFiles);
                    }
                  }}
                  placeholder={session ? t('chat.inputPlaceholder') : t('chat.selectOrCreateSession')}
                  disabled={!session || !!streaming}
                  rows={2}
                  className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                />
                {streaming ? (
                  <Button variant="danger" size="md" onClick={stopStream}>
                    {t('chat.stop')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={sendMessage}
                    disabled={!draft.trim() || !session}
                  >
                    {t('chat.send')}
                  </Button>
                )}
              </div>
              <div className="text-xs text-gray-600 mt-1.5 flex justify-between">
                <span>{t('chat.inputHint')}</span>
                {session && <span className="text-gray-700">{session.messages.filter((m) => m.role !== 'system').length} {t('chat.messages')}</span>}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StreamingActivity({ phase, activeToolName }: { phase: StreamingPhase; activeToolName?: string }) {
  const { t } = useTranslation();
  const label = phase === 'tool_call' && activeToolName
    ? t(streamingStatusKey(phase), { tool: activeToolName })
    : t(streamingStatusKey(phase));

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-violet-800/40 bg-gray-900/60 px-3 py-1.5 text-xs text-gray-400 shadow-[0_0_24px_rgba(124,58,237,0.08)]">
      <span className="relative flex h-4 w-4 items-center justify-center">
        <span className="absolute h-4 w-4 rounded-full bg-violet-500/20 animate-ping" />
        <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.7)]" />
      </span>
      <span>{label}</span>
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="h-1 w-1 rounded-full bg-violet-300 animate-bounce [animation-delay:-0.2s]" />
        <span className="h-1 w-1 rounded-full bg-violet-300 animate-bounce [animation-delay:-0.1s]" />
        <span className="h-1 w-1 rounded-full bg-violet-300 animate-bounce" />
      </span>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`${isUser ? 'bg-violet-900/20 border-violet-800/60' : 'bg-gray-800/60 border-gray-700'} border rounded-lg p-3`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-xs font-medium ${isUser ? 'text-violet-300' : 'text-cyan-400'}`}>
          {isUser ? t('chat.you') : t('chat.assistant')}
        </span>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(message.content)}
          className="text-xs text-gray-600 hover:text-gray-400"
          title={t('common.copy')}
        >
          ⧉
        </button>
      </div>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mb-2 space-y-1">
          {message.toolCalls.map((tc) => (
            <ToolCallRow
              key={tc.id}
              call={{
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                success: tc.success,
                summary: tc.error ?? undefined,
                result: tc.result,
              }}
            />
          ))}
        </div>
      )}
      <div className="text-gray-200 text-sm">
        <Markdown>{message.content}</Markdown>
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-700/60 flex flex-wrap gap-1.5">
          {message.attachments.map((att) => {
            const isImg = att.kind === 'image';
            const href = `/api/attachments/${att.attachmentId}/download`;
            if (isImg) {
              return (
                <a
                  key={att.attachmentId}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                  title={att.fileName}
                >
                  <img
                    src={href}
                    alt={att.fileName}
                    className="max-h-32 max-w-[180px] rounded border border-gray-700 object-cover"
                  />
                </a>
              );
            }
            return (
              <a
                key={att.attachmentId}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-900/70 border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 font-mono"
                title={`${(att.size / 1024).toFixed(1)} KB${att.extractedLength ? ` · ${att.extractedLength} chars eingebunden` : ''}`}
              >
                📎 {att.fileName}
              </a>
            );
          })}
        </div>
      )}
      {message.contextUsed && message.contextUsed.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-700/60">
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            {expanded ? '▾' : '▸'} {t('chat.contextUsed', { count: message.contextUsed.length })}
          </button>
          {expanded && <ContextRefs refs={message.contextUsed} />}
        </div>
      )}
      {message.metrics && <MetricsBadge metrics={message.metrics} />}
    </div>
  );
}

function MetricsBadge({ metrics }: { metrics: ChatResponseMetrics }) {
  const { t } = useTranslation();
  const tps = metrics.tokensPerSecond;
  const totalSec = (metrics.totalDurationMs ?? metrics.durationMs) / 1000;
  const ttfMs = metrics.firstTokenMs;
  const prefix = metrics.estimated ? '≈ ' : '';
  return (
    <div
      className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-gray-500 font-mono"
      title={t('chat.metricsTitle', {
        outputTokens: metrics.outputTokens,
        durationMs: metrics.durationMs,
        firstTokenMs: ttfMs ?? '—',
        estimated: metrics.estimated ? t('chat.metricsEstimated') : t('chat.metricsExact'),
      })}
    >
      <span className="px-1.5 py-0.5 rounded border border-violet-900/40 bg-violet-950/30 text-violet-300">
        {prefix}{tps} {t('chat.metricsTokensPerSec')}
      </span>
      <span className="text-gray-600">{totalSec.toFixed(1)} s</span>
      {ttfMs != null && metrics.totalDurationMs && metrics.totalDurationMs !== metrics.durationMs && (
        <span className="text-gray-700">· {t('chat.metricsTotal')} {(metrics.totalDurationMs / 1000).toFixed(1)} s</span>
      )}
    </div>
  );
}

function ToolCallRow({
  call,
}: {
  call: StreamingToolCall & { result?: string };
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const pending = call.success === undefined;
  const failed = call.success === false;

  let prettyArgs = call.arguments;
  try {
    prettyArgs = JSON.stringify(JSON.parse(call.arguments), null, 2);
  } catch {
    /* keep as-is */
  }

  return (
    <div className={`text-xs rounded border px-2 py-1 ${
      failed ? 'border-red-800/60 bg-red-900/20' : pending ? 'border-amber-800/60 bg-amber-900/10' : 'border-gray-700 bg-gray-900/60'
    }`}>
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center gap-2 text-left"
      >
        <span className={failed ? 'text-red-400' : pending ? 'text-amber-400' : 'text-green-400'}>
          {pending ? '⟳' : failed ? '✗' : '✓'}
        </span>
        <span className="font-mono text-gray-300">{call.name}</span>
        <span className="text-gray-500 truncate flex-1">
          {call.summary ?? (pending ? t('chat.toolRunning') : '')}
        </span>
        <span className="text-gray-600">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          <pre className="text-gray-400 font-mono text-[10px] bg-gray-900 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all">
            {prettyArgs}
          </pre>
          {call.result && (
            <pre className="text-gray-500 font-mono text-[10px] bg-gray-900 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
              {call.result.length > 1000 ? call.result.slice(0, 1000) + '…' : call.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ContextRefs({ refs }: { refs: ChatContextRef[] }) {
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-gray-500">
      {refs.map((r, i) => (
        <li key={i} className="truncate">
          <span className="text-gray-600">[{r.entity}]</span>{' '}
          <span className="text-gray-400">{r.title || '(ohne Titel)'}</span>
          {typeof r.score === 'number' && (
            <span className="text-gray-700"> · {Math.round(r.score * 100)}%</span>
          )}
        </li>
      ))}
    </ul>
  );
}
