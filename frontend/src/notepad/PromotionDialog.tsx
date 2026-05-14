import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Loader2, X } from 'lucide-react';
import { useToast } from '../components/Toast';
import { api, getCurrentAccessToken } from '../api/client';
import { notesApi } from './api';
import type {
  Note,
  PromotionProposal,
  PromotedEntityType,
  PromotionCommitInput,
} from './types';

interface Props {
  note: Note;
  onCancel: () => void;
  onDone: (result: { entityLink: string }) => void;
}

interface ProjectOption {
  _id: string;
  name: string;
}

interface CustomerOption {
  _id: string;
  name: string;
}

const ENTITY_TYPES: PromotedEntityType[] = [
  'knowledge',
  'snippet',
  'todo',
  'research',
  'manual',
];

export default function PromotionDialog({ note, onCancel, onDone }: Props) {
  const { t } = useTranslation();
  const { showError } = useToast();

  const [phase, setPhase] = useState<'analyzing' | 'review' | 'saving' | 'error'>(
    'analyzing',
  );
  const [streamingText, setStreamingText] = useState('');
  const [proposal, setProposal] = useState<PromotionProposal | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Form state (initialized from proposal once it arrives)
  const [entityType, setEntityType] = useState<PromotedEntityType>('knowledge');
  const [projectId, setProjectId] = useState<string>('');
  const [customerId, setCustomerId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [showFallback, setShowFallback] = useState(false);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  // Load projects + customers for the dropdowns once.
  useEffect(() => {
    void (async () => {
      try {
        const [p, c] = await Promise.all([
          api.projects.list({ active: true }).catch(() => []),
          api.customers.list({ includeArchived: false }).catch(() => []),
        ]);
        setProjects(
          (p as Array<{ _id: string; name: string }>).map((x) => ({
            _id: x._id,
            name: x.name,
          })),
        );
        setCustomers(
          (c as Array<{ _id: string; name: string }>).map((x) => ({
            _id: x._id,
            name: x.name,
          })),
        );
      } catch {
        /* dropdowns degrade to empty */
      }
    })();
  }, []);

  // Stream the promotion analysis via fetch + ReadableStream (same pattern as
  // ChatDock — avoids the EventSource limitation of not being able to send
  // Authorization headers).
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const handlePayload = (payload: { type?: string; [key: string]: unknown }) => {
      switch (payload.type) {
        case 'token':
          setStreamingText((prev) => prev + String(payload.text ?? ''));
          break;
        case 'proposal': {
          const p = payload.proposal as PromotionProposal | undefined;
          if (!p) {
            setPhase('error');
            setErrorMessage(t('vermerke.promoteParseError'));
            return;
          }
          setProposal(p);
          setEntityType(p.entityType);
          setProjectId(p.projectId ?? '');
          setCustomerId(p.customerId ?? '');
          setTitle(p.title || note.title);
          setTagsText((p.tags ?? []).join(', '));
          if (!p.projectId && !p.customerId) setShowFallback(true);
          setPhase('review');
          break;
        }
        case 'error':
          setPhase('error');
          setErrorMessage(
            String(payload.message ?? '') || t('vermerke.promoteLlmError'),
          );
          break;
        // status / done / unknown → ignore (done closes the stream naturally)
      }
    };

    (async () => {
      try {
        const headers: Record<string, string> = {};
        const token = getCurrentAccessToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`/api/notes/${note._id}/promote`, {
          method: 'POST',
          headers,
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          let msg = res.statusText;
          try {
            const errBody = await res.json();
            if (errBody?.message) msg = errBody.message;
          } catch {
            /* ignore */
          }
          if (cancelled) return;
          setPhase('error');
          setErrorMessage(msg || t('vermerke.promoteLlmError'));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled) return;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              handlePayload(JSON.parse(data));
            } catch {
              /* ignore bad SSE chunk */
            }
          }
        }
      } catch (err: any) {
        if (cancelled || err?.name === 'AbortError') return;
        setPhase('error');
        setErrorMessage(err?.message || t('vermerke.promoteLlmError'));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [note._id, note.title, t]);

  const tags = useMemo(
    () =>
      tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    [tagsText],
  );

  const canSubmit = useMemo(() => {
    if (!title.trim()) return false;
    // knowledge can go global; everything else needs at least one of project/customer
    if (entityType === 'knowledge') return true;
    return Boolean(projectId || customerId);
  }, [entityType, projectId, customerId, title]);

  const handleSave = useCallback(async () => {
    const payload: PromotionCommitInput = {
      entityType,
      title: title.trim(),
      reasoning: proposal?.reasoning,
    };
    if (projectId) payload.projectId = projectId;
    if (customerId) payload.customerId = customerId;
    if (tags.length > 0) payload.tags = tags;
    setPhase('saving');
    try {
      const result = await notesApi.promoteCommit(note._id, payload);
      onDone({ entityLink: result.entityLink });
    } catch (err) {
      setPhase('review');
      const msg = err instanceof Error ? err.message : t('vermerke.promoteSaveError');
      showError(msg);
    }
  }, [
    customerId,
    entityType,
    note._id,
    onDone,
    projectId,
    proposal,
    showError,
    t,
    tags,
    title,
  ]);

  const handleGlobalKnowledge = useCallback(() => {
    setEntityType('knowledge');
    setProjectId('');
    setCustomerId('');
    setShowFallback(false);
  }, []);

  const handleManual = useCallback(() => {
    setShowFallback(false);
  }, []);

  const handleSnooze = useCallback(async () => {
    try {
      await notesApi.snooze(note._id);
      onCancel();
    } catch {
      showError(t('vermerke.errorSnooze'));
    }
  }, [note._id, onCancel, showError, t]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-400" />
            <h3 className="text-base font-semibold text-gray-100">
              {t('vermerke.promoteTitle')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-200 p-1"
            aria-label={t('vermerke.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {phase === 'analyzing' && (
          <div className="p-5">
            <div className="flex items-center gap-2 text-sm text-gray-300 mb-3">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t('vermerke.promoteAnalyzing')}</span>
            </div>
            {streamingText && (
              <pre className="text-xs text-gray-500 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto bg-gray-950 p-2 rounded border border-gray-800">
                {streamingText}
              </pre>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="p-5">
            <p className="text-sm text-red-400 mb-3">
              {errorMessage || t('vermerke.promoteLlmError')}
            </p>
            <p className="text-sm text-gray-400 mb-4">
              {t('vermerke.promoteManualHint')}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPhase('review')}
                className="bg-amber-700 hover:bg-amber-600 text-white text-sm px-4 py-2 rounded"
              >
                {t('vermerke.promoteManualButton')}
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="text-gray-400 hover:text-gray-200 text-sm px-4 py-2 rounded"
              >
                {t('vermerke.cancel')}
              </button>
            </div>
          </div>
        )}

        {(phase === 'review' || phase === 'saving') && (
          <div className="p-5 flex flex-col gap-3">
            {showFallback && (
              <div className="bg-amber-950/30 border border-amber-900 rounded p-3">
                <p className="text-sm text-amber-300 mb-2">
                  {t('vermerke.promoteAmbiguous')}
                </p>
                {note.promotionAttempts >= 5 && (
                  <p className="text-xs text-amber-400/70 mb-2">
                    {t('vermerke.promoteManyAttempts', {
                      count: note.promotionAttempts,
                    })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleManual}
                    className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-1.5 rounded"
                  >
                    {t('vermerke.promoteAssignManually')}
                  </button>
                  {entityType === 'knowledge' && (
                    <button
                      type="button"
                      onClick={handleGlobalKnowledge}
                      className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-1.5 rounded"
                    >
                      {t('vermerke.promoteGlobal')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleSnooze}
                    className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded"
                  >
                    {t('vermerke.promoteAskLater')}
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="text-xs text-gray-400 block mb-1">
                {t('vermerke.promoteEntityType')}
              </label>
              <select
                value={entityType}
                onChange={(e) => setEntityType(e.target.value as PromotedEntityType)}
                className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm px-3 py-1.5 rounded outline-none"
              >
                {ENTITY_TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {t(`vermerke.entityType.${tp}`)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-400 block mb-1">
                {t('vermerke.promoteTitleField')}
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm px-3 py-1.5 rounded outline-none"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 block mb-1">
                {t('vermerke.promoteProject')}
              </label>
              <select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  if (e.target.value) setCustomerId('');
                }}
                className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm px-3 py-1.5 rounded outline-none"
              >
                <option value="">{t('vermerke.promoteNone')}</option>
                {projects.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-400 block mb-1">
                {t('vermerke.promoteCustomer')}
              </label>
              <select
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  if (e.target.value) setProjectId('');
                }}
                className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm px-3 py-1.5 rounded outline-none"
              >
                <option value="">{t('vermerke.promoteNone')}</option>
                {customers.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {(entityType === 'knowledge' ||
              entityType === 'snippet' ||
              entityType === 'todo') && (
              <div>
                <label className="text-xs text-gray-400 block mb-1">
                  {t('vermerke.promoteTags')}
                </label>
                <input
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder={t('vermerke.promoteTagsPlaceholder')}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm px-3 py-1.5 rounded outline-none"
                />
              </div>
            )}

            {proposal?.reasoning && (
              <details className="text-xs">
                <summary className="text-gray-400 cursor-pointer hover:text-gray-200">
                  {t('vermerke.promoteReasoning')}
                </summary>
                <p className="text-gray-500 mt-1 italic">{proposal.reasoning}</p>
              </details>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-800 mt-2">
              <button
                type="button"
                onClick={onCancel}
                className="text-sm text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded"
                disabled={phase === 'saving'}
              >
                {t('vermerke.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSubmit || phase === 'saving'}
                className="bg-amber-700 hover:bg-amber-600 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm px-4 py-1.5 rounded flex items-center gap-2"
              >
                {phase === 'saving' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('vermerke.promoteSave')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
