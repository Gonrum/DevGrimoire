import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  api,
  Project,
  ResearchChatContextRef,
  ResearchSessionDetail,
  ResearchSessionStatus,
  ResearchStepEntry,
  ResearchStepMessage,
  ResearchStepStatus,
} from '../api/client';
import { useToast } from '../components/Toast';
import { LoadingText } from '../components/ui/LoadingSpinner';
import Markdown from '../components/Markdown';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';

type MobileTab = 'steps' | 'chat' | 'context';

const SELECTED_STEP_KEY_PREFIX = 'research.lastSelectedStep:';

export default function ResearchSessionPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { showError, showSuccess } = useToast();
  const [detail, setDetail] = useState<ResearchSessionDetail | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [newStepTitle, setNewStepTitle] = useState('');
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');

  const projectsById = useMemo(() => new Map(projects.map((p) => [p._id, p])), [projects]);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [d, p] = await Promise.all([
        api.researchSessions.get(id),
        api.projects.list({ active: true }),
      ]);
      setDetail(d);
      setProjects(p);
      const saved = window.localStorage.getItem(SELECTED_STEP_KEY_PREFIX + id);
      const initial = saved && d.steps.find((s) => s._id === saved) ? saved : d.steps[0]?._id ?? null;
      setActiveStepId(initial);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  useEffect(() => {
    if (id && activeStepId) {
      window.localStorage.setItem(SELECTED_STEP_KEY_PREFIX + id, activeStepId);
    }
  }, [id, activeStepId]);

  if (loading || !detail) return <LoadingText />;
  const { session, steps } = detail;
  const activeStep = steps.find((s) => s._id === activeStepId) ?? null;

  const saveTitle = async () => {
    if (!id || !titleDraft.trim() || titleDraft === session.title) {
      setEditingTitle(false);
      return;
    }
    try {
      const updated = await api.researchSessions.update(id, { title: titleDraft.trim() });
      setDetail({ ...detail, session: updated });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditingTitle(false);
    }
  };

  const toggleProject = async (pid: string) => {
    if (!id) return;
    const next = session.projectIds.includes(pid)
      ? session.projectIds.filter((p) => p !== pid)
      : [...session.projectIds, pid];
    try {
      const updated = await api.researchSessions.update(id, { projectIds: next });
      setDetail({ ...detail, session: updated });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const cycleStatus = async (
    current: ResearchSessionStatus,
    direction: 1 | -1,
  ): Promise<void> => {
    if (!id) return;
    const order: ResearchSessionStatus[] = ['open', 'in_progress', 'done'];
    const idx = order.indexOf(current);
    const next = order[idx + direction];
    if (!next) return;
    try {
      const updated = await api.researchSessions.update(id, { status: next });
      setDetail({ ...detail, session: updated });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const addStep = async () => {
    if (!id || !newStepTitle.trim()) return;
    try {
      const step = await api.researchSessions.createStep(id, { title: newStepTitle.trim() });
      setDetail({ ...detail, steps: [...steps, step] });
      setActiveStepId(step._id);
      setNewStepTitle('');
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateStepStatus = async (
    step: ResearchStepEntry,
    direction: 1 | -1,
  ): Promise<void> => {
    if (!id) return;
    const order: ResearchStepStatus[] = ['open', 'in_progress', 'done'];
    const idx = order.indexOf(step.status);
    const next = order[idx + direction];
    if (!next) return;
    try {
      const updated = await api.researchSessions.updateStep(id, step._id, { status: next });
      setDetail({
        ...detail,
        steps: steps.map((s) => (s._id === step._id ? updated : s)),
      });
      if (next === 'done' && updated.researchEntryId) {
        showSuccess(t('research.autoSaved'));
      }
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteStep = async (stepId: string) => {
    if (!id) return;
    try {
      await api.researchSessions.deleteStep(id, stepId);
      const remaining = steps.filter((s) => s._id !== stepId);
      setDetail({ ...detail, steps: remaining });
      if (activeStepId === stepId) setActiveStepId(remaining[0]?._id ?? null);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const onMessageAppended = (
    stepId: string,
    userMsg: ResearchStepMessage,
    assistantMsg: ResearchStepMessage,
  ) => {
    setDetail((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        steps: prev.steps.map((s) =>
          s._id === stepId ? { ...s, messages: [...s.messages, userMsg, assistantMsg] } : s,
        ),
      };
    });
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-4">
        <Link to="/research" className="text-sm text-gray-500 hover:text-gray-300">
          &larr; {t('research.backToOverview')}
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-sm font-mono text-gray-500">{session.displayNumber}</span>
          {editingTitle ? (
            <input
              autoFocus
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-lg font-semibold text-gray-200 focus:outline-none focus:border-violet-500"
            />
          ) : (
            <h1
              className="text-lg sm:text-xl font-semibold font-grimoire cursor-pointer hover:text-violet-300 truncate"
              onClick={() => {
                setTitleDraft(session.title);
                setEditingTitle(true);
              }}
            >
              {session.title}
            </h1>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => cycleStatus(session.status, -1)}>
            ◀
          </Button>
          <Badge color={statusColor(session.status)} rounded="full">
            {t(`research.status${capitalize(session.status)}` as never)}
          </Badge>
          <Button variant="secondary" size="sm" onClick={() => cycleStatus(session.status, 1)}>
            ▶
          </Button>
        </div>
      </div>

      <ProjectChips
        session={session}
        projects={projects}
        projectsById={projectsById}
        onToggle={toggleProject}
      />

      {/* Mobile tabs */}
      <div className="lg:hidden flex border-b border-gray-800 mb-3">
        {(['steps', 'chat', 'context'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMobileTab(tab)}
            className={`px-3 py-2 text-sm transition-colors ${
              mobileTab === tab
                ? 'text-violet-300 border-b-2 border-violet-500'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t(`research.tab${capitalize(tab)}` as never)}
          </button>
        ))}
      </div>

      {/* 3-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_280px] gap-4">
        {/* Steps sidebar */}
        <div className={`${mobileTab === 'steps' ? 'block' : 'hidden'} lg:block space-y-1`}>
          {steps.map((step) => (
            <button
              key={step._id}
              type="button"
              onClick={() => {
                setActiveStepId(step._id);
                setMobileTab('chat');
              }}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                step._id === activeStepId
                  ? 'bg-violet-900/40 text-violet-200'
                  : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
              }`}
            >
              <span>{stepStatusIcon(step.status)}</span>
              <span className="flex-1 truncate">{step.title}</span>
            </button>
          ))}
          <div className="flex gap-1 mt-2">
            <input
              type="text"
              value={newStepTitle}
              onChange={(e) => setNewStepTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addStep();
              }}
              placeholder={t('research.newStepPlaceholder')}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
            />
            <Button variant="secondary" size="sm" onClick={addStep}>
              +
            </Button>
          </div>
        </div>

        {/* Chat */}
        <div className={`${mobileTab === 'chat' ? 'block' : 'hidden'} lg:block`}>
          {activeStep ? (
            <ResearchStepChat
              key={activeStep._id}
              sessionId={session._id}
              step={activeStep}
              onAppend={onMessageAppended}
              onStatusChange={(dir) => updateStepStatus(activeStep, dir)}
              onDelete={() => deleteStep(activeStep._id)}
              sessionProjectsCount={session.projectIds.length}
            />
          ) : (
            <div className="p-6 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-500 text-center">
              {t('research.noStepSelected')}
            </div>
          )}
        </div>

        {/* Context pane */}
        <div className={`${mobileTab === 'context' ? 'block' : 'hidden'} lg:block`}>
          {activeStep ? (
            <ContextPane step={activeStep} />
          ) : (
            <div className="p-3 text-xs text-gray-600">{t('research.contextEmpty')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ProjectChipsProps {
  session: ResearchSessionDetail['session'];
  projects: Project[];
  projectsById: Map<string, Project>;
  onToggle: (id: string) => void;
}

function ProjectChips({ session, projects, projectsById, onToggle }: ProjectChipsProps) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const availableToAdd = projects.filter((p) => !session.projectIds.includes(p._id));

  return (
    <div className="flex items-center flex-wrap gap-2 mb-4">
      <span className="text-xs text-gray-500">{t('research.projectsLabel')}:</span>
      {session.projectIds.length === 0 && (
        <span className="text-xs text-amber-400">{t('research.noProjectsHint')}</span>
      )}
      {session.projectIds.map((pid) => {
        const p = projectsById.get(pid);
        return (
          <span
            key={pid}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-900/40 text-violet-300 text-xs"
          >
            <span>{p ? p.name : t('research.unknownProject')}</span>
            <button
              type="button"
              onClick={() => onToggle(pid)}
              className="text-violet-300/60 hover:text-violet-200 leading-none"
            >
              ×
            </button>
          </span>
        );
      })}
      {availableToAdd.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            onBlur={() => setTimeout(() => setAdding(false), 150)}
            className="text-xs px-2 py-0.5 rounded-full bg-gray-800 hover:bg-gray-700 text-gray-300"
          >
            + {t('research.addProject')}
          </button>
          {adding && (
            <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-10 max-h-60 overflow-y-auto">
              {availableToAdd.map((p) => (
                <button
                  key={p._id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onToggle(p._id);
                    setAdding(false);
                  }}
                  className="block w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 whitespace-nowrap"
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ResearchStepChatProps {
  sessionId: string;
  step: ResearchStepEntry;
  onAppend: (stepId: string, user: ResearchStepMessage, assistant: ResearchStepMessage) => void;
  onStatusChange: (direction: 1 | -1) => void;
  onDelete: () => void;
  sessionProjectsCount: number;
}

function ResearchStepChat({
  sessionId,
  step,
  onAppend,
  onStatusChange,
  onDelete,
  sessionProjectsCount,
}: ResearchStepChatProps) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingRefs, setStreamingRefs] = useState<ResearchChatContextRef[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [step.messages.length, streamingContent]);

  const send = async () => {
    if (!input.trim() || streaming || sessionProjectsCount === 0) return;
    const content = input.trim();
    setInput('');
    setStreaming(true);
    setStreamingContent('');
    setStreamingRefs([]);

    const controller = new AbortController();
    abortRef.current = controller;
    const userMsg: ResearchStepMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await fetch(
        `/api/research/sessions/${sessionId}/steps/${step._id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
          signal: controller.signal,
          credentials: 'include',
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      let assistantContent = '';
      let assistantRefs: ResearchChatContextRef[] = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const evt of events) {
          const line = evt.trim();
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            const parsed = JSON.parse(json) as
              | { type: 'context'; refs: ResearchChatContextRef[] }
              | { type: 'token'; content: string }
              | { type: 'done' }
              | { type: 'error'; message: string };
            if (parsed.type === 'context') {
              assistantRefs = parsed.refs;
              setStreamingRefs(parsed.refs);
            } else if (parsed.type === 'token') {
              assistantContent += parsed.content;
              setStreamingContent(assistantContent);
            } else if (parsed.type === 'error') {
              throw new Error(parsed.message);
            }
          } catch {
            // ignore malformed event
          }
        }
      }
      const assistantMsg: ResearchStepMessage = {
        role: 'assistant',
        content: assistantContent,
        timestamp: new Date().toISOString(),
        contextUsed: assistantRefs,
      };
      onAppend(step._id, userMsg, assistantMsg);
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        showError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStreaming(false);
      setStreamingContent('');
      setStreamingRefs([]);
      abortRef.current = null;
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg flex flex-col h-[calc(100vh-280px)] min-h-[400px]">
      {/* Step header */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-gray-500 text-lg">{stepStatusIcon(step.status)}</span>
          <h2 className="text-base font-medium text-gray-200 truncate">{step.title}</h2>
          {step.researchEntryId && (
            <Badge color="bg-green-900/40 text-green-300" rounded="full">
              {t('research.savedAsResearch')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="xs" onClick={() => onStatusChange(-1)}>◀</Button>
          <Button variant="secondary" size="xs" onClick={() => onStatusChange(1)}>▶</Button>
          <Button variant="danger" size="xs" onClick={onDelete}>×</Button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {step.messages.length === 0 && !streaming && (
          <p className="text-sm text-gray-500 text-center py-6">{t('research.askYourFirstQuestion')}</p>
        )}
        {step.messages.map((m, i) => (
          <MessageBubble key={`${m.timestamp}-${i}`} message={m} />
        ))}
        {streaming && (
          <MessageBubble
            message={{
              role: 'assistant',
              content: streamingContent || '…',
              timestamp: new Date().toISOString(),
              contextUsed: streamingRefs,
            }}
            streaming
          />
        )}
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={streaming || step.status === 'done' || sessionProjectsCount === 0}
            placeholder={
              sessionProjectsCount === 0
                ? t('research.selectProjectsFirst')
                : step.status === 'done'
                ? t('research.stepDoneNoInput')
                : t('research.askPlaceholder')
            }
            rows={2}
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-none disabled:opacity-50"
          />
          <Button
            variant="primary"
            size="md"
            onClick={send}
            disabled={!input.trim() || streaming || step.status === 'done' || sessionProjectsCount === 0}
          >
            {streaming ? '…' : t('research.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  streaming = false,
}: {
  message: ResearchStepMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
          isUser
            ? 'bg-violet-900/30 text-violet-100'
            : 'bg-gray-800 text-gray-200'
        } ${streaming ? 'animate-pulse' : ''}`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <Markdown>{message.content}</Markdown>
        )}
      </div>
    </div>
  );
}

function ContextPane({ step }: { step: ResearchStepEntry }) {
  const { t } = useTranslation();
  const lastAssistant = [...step.messages].reverse().find((m) => m.role === 'assistant');
  const refs = lastAssistant?.contextUsed ?? [];

  if (refs.length === 0) {
    return (
      <div className="p-3 text-xs text-gray-600">
        {t('research.contextEmpty')}
      </div>
    );
  }

  const groups = new Map<string, ResearchChatContextRef[]>();
  for (const ref of refs) {
    if (!groups.has(ref.entity)) groups.set(ref.entity, []);
    groups.get(ref.entity)!.push(ref);
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-3">
      <h3 className="text-xs uppercase tracking-wide text-gray-500">
        {t('research.contextTitle')}
      </h3>
      {[...groups.entries()].map(([entity, hits]) => (
        <div key={entity}>
          <p className="text-xs text-gray-500 mb-1">{entity} ({hits.length})</p>
          <ul className="space-y-0.5">
            {hits.map((hit) => (
              <li
                key={`${hit.entity}-${hit.entityId}`}
                className="text-xs text-gray-300 hover:text-violet-300 truncate"
              >
                {hit.title || hit.entityId}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function statusColor(status: ResearchSessionStatus): string {
  switch (status) {
    case 'open':
      return 'bg-gray-800 text-gray-400';
    case 'in_progress':
      return 'bg-cyan-900/40 text-cyan-300';
    case 'done':
      return 'bg-green-900/40 text-green-300';
  }
}

function stepStatusIcon(status: ResearchStepStatus): string {
  switch (status) {
    case 'open':
      return '○';
    case 'in_progress':
      return '◐';
    case 'done':
      return '✓';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_./g, (m) => m[1].toUpperCase());
}
