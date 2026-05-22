import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, Question } from '../../api/client';
import Markdown from '../Markdown';
import MarkdownEditor from '../MarkdownEditor';
import Button from '../ui/Button';
import DetailSection from '../ui/DetailSection';

interface Props {
  todoId: string;
  projectId?: string;
  questions: Question[];
  onChanged: () => void;
  onError: (message: string) => void;
  basePath?: string;
}

/**
 * Two-way Q&A section on a todo (M-30):
 * - Open agent→user questions get an answer form (any user with project scope
 *   may respond — also after the agent's wait window has expired).
 * - User→agent questions are visible too, with their answer when an agent
 *   answers via MCP.
 * - Bottom form: user can ask the agent a follow-up — also on `done` todos.
 */
export default function TodoQuestionsSection({ todoId, projectId, questions, onChanged, onError, basePath }: Props) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const open = useMemo(() => questions.filter((q) => q.status !== 'answered'), [questions]);
  const answered = useMemo(() => questions.filter((q) => q.status === 'answered'), [questions]);

  const handleAskAgent = async () => {
    if (!draft.trim()) return;
    setSubmitting(true);
    try {
      await api.questions.createUserToAgent({
        question: draft.trim(),
        todoId,
        projectId,
      });
      setDraft('');
      onChanged();
    } catch (err) {
      onError((err as Error).message || 'Failed to ask agent');
    } finally {
      setSubmitting(false);
    }
  };

  if (questions.length === 0) {
    return (
      <DetailSection title={t('questions.sectionTitle')}>
        <p className="text-xs text-gray-700 italic mb-3">{t('questions.empty')}</p>
        <AskAgentForm
          draft={draft}
          setDraft={setDraft}
          submitting={submitting}
          onSubmit={handleAskAgent}
        />
      </DetailSection>
    );
  }

  return (
    <DetailSection
      title={t('questions.sectionTitle')}
      meta={open.length > 0 ? `(${open.length} ${t('questions.openShort')})` : undefined}
    >
      <div className="space-y-3 mb-4">
        {open.map((q) => (
          <QuestionCard
            key={q._id}
            question={q}
            dateLocale={dateLocale}
            onAnswer={async (answer) => {
              try {
                await api.questions.answer(q._id, answer);
                onChanged();
              } catch (err) {
                onError((err as Error).message || 'Failed to answer question');
              }
            }}
          />
        ))}
        {answered.length > 0 && (
          <details className="rounded border border-gray-800 bg-gray-900/40 p-2">
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">
              {t('questions.historyHeading', { count: answered.length })}
            </summary>
            <div className="mt-2 space-y-2">
              {answered.map((q) => (
                <AnsweredQuestionCard
                  key={q._id}
                  question={q}
                  dateLocale={dateLocale}
                  projectId={projectId}
                  onChanged={onChanged}
                  onError={onError}
                  basePath={basePath}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      <AskAgentForm
        draft={draft}
        setDraft={setDraft}
        submitting={submitting}
        onSubmit={handleAskAgent}
      />
    </DetailSection>
  );
}

function QuestionCard({
  question,
  dateLocale,
  onAnswer,
}: {
  question: Question;
  dateLocale: string;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isUserToAgent = question.direction === 'user_to_agent';
  const isExpired = question.status === 'expired';
  const accent = isUserToAgent
    ? 'border-cyan-700/40 bg-cyan-950/20'
    : isExpired
      ? 'border-amber-700/40 bg-amber-950/20'
      : 'border-violet-700/50 bg-violet-950/30';

  const headerKey = isUserToAgent
    ? 'questions.headerUserToAgent'
    : isExpired
      ? 'questions.headerAgentExpired'
      : 'questions.headerAgentPending';

  const submit = async (chosen: string) => {
    if (!chosen.trim()) return;
    setSubmitting(true);
    try {
      await onAnswer(chosen.trim());
      setAnswer('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`rounded border p-3 ${accent}`}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500 mb-1.5">
        <span className="font-medium tracking-wide uppercase">
          {t(headerKey)}
          {question.agentName ? ` · ${question.agentName}` : ''}
        </span>
        <span>{new Date(question.createdAt).toLocaleString(dateLocale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <Markdown className="text-sm text-gray-200">{question.question}</Markdown>
      {question.context && (
        <div className="mt-1.5 text-xs text-gray-500 border-l-2 border-gray-700 pl-2">
          <Markdown>{question.context}</Markdown>
        </div>
      )}

      {!isUserToAgent && (
        <div className="mt-3">
          {question.options && question.options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {question.options.map((opt) => (
                <Button
                  key={opt}
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={submitting}
                  onClick={() => submit(opt)}
                >
                  {opt}
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={2}
                placeholder={t('questions.answerPlaceholder')}
                className="flex-1 min-w-0 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
              />
              <Button
                type="button"
                variant="primary"
                disabled={submitting || !answer.trim()}
                onClick={() => submit(answer)}
              >
                {submitting ? '...' : t('questions.answerSubmit')}
              </Button>
            </div>
          )}
          {isExpired && (
            <p className="mt-2 text-[11px] text-amber-400/70">
              {t('questions.expiredHint')}
            </p>
          )}
        </div>
      )}

      {isUserToAgent && (
        <p className="mt-2 text-[11px] text-cyan-300/80 italic">
          {t('questions.waitingForAgent')}
        </p>
      )}
    </div>
  );
}

function AnsweredQuestionCard({
  question,
  dateLocale,
  projectId,
  onChanged,
  onError,
  basePath,
}: {
  question: Question;
  dateLocale: string;
  projectId?: string;
  onChanged: () => void;
  onError: (message: string) => void;
  basePath?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const headerKey = question.direction === 'user_to_agent'
    ? 'questions.headerUserToAgent'
    : 'questions.headerAgentAnswered';
  const answeredByLabel = question.answeredByAgent
    ? t('questions.answeredByAgent')
    : t('questions.answeredByUser');

  const defaultContent = `${t('questions.frageLabel')} ${question.question}\n\n${t('questions.answerLabel')} ${question.answer ?? ''}`;

  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveTopic, setSaveTopic] = useState(question.question.slice(0, 80));
  const [saveTags, setSaveTags] = useState('');
  const [saveCategory, setSaveCategory] = useState('');
  const [saveContent, setSaveContent] = useState(defaultContent);
  const [saving, setSaving] = useState(false);

  const handleSaveAsKnowledge = async () => {
    setSaving(true);
    try {
      await api.questions.convertToKnowledge(question._id, {
        topic: saveTopic.trim() || question.question.slice(0, 80),
        tags: saveTags ? saveTags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        category: saveCategory.trim() || undefined,
        content: saveContent,
        scope: projectId ? 'project' : undefined,
      });
      setShowSaveForm(false);
      setSaveContent(defaultContent);
      onChanged();
    } catch (err) {
      onError((err as Error).message || t('questions.saveAsKnowledgeFailed'));
    } finally {
      setSaving(false);
    }
  };

  const knowledgePath = basePath
    ? basePath.replace(/\/todos\/.*$/, '/knowledge')
    : projectId
      ? `/projects/${projectId}/knowledge`
      : undefined;

  return (
    <div className="rounded border border-gray-800 bg-gray-950/40 p-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500 mb-1">
        <span className="font-medium tracking-wide uppercase">{t(headerKey)}</span>
        <span>{question.answeredAt ? new Date(question.answeredAt).toLocaleString(dateLocale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
      <Markdown className="text-sm text-gray-300">{question.question}</Markdown>
      {question.answer && (
        <div className="mt-2 text-xs">
          <span className="text-gray-500">{answeredByLabel}:</span>
          <Markdown className="text-gray-200 mt-0.5">{question.answer}</Markdown>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        {!question.knowledgeId && !showSaveForm && (
          <Button type="button" size="xs" variant="accent" onClick={() => { setSaveContent(defaultContent); setShowSaveForm(true); }}>
            {t('questions.saveAsKnowledge')}
          </Button>
        )}
        {question.knowledgeId && knowledgePath && (
          <Button type="button" size="xs" variant="ghost-blue" onClick={() => navigate(knowledgePath)}>
            {t('questions.openKnowledge')}
          </Button>
        )}
      </div>

      {showSaveForm && !question.knowledgeId && (
        <div className="mt-3 p-3 rounded border border-violet-800/40 bg-violet-950/20 space-y-2">
          <p className="text-xs font-medium text-violet-300">{t('questions.saveAsKnowledgeTitle')}</p>
          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">{t('questions.saveAsKnowledgeTopic')}</label>
            <input
              type="text"
              value={saveTopic}
              onChange={(e) => setSaveTopic(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-violet-500"
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">{t('questions.contentLabel')}</label>
            <MarkdownEditor
              value={saveContent}
              onChange={setSaveContent}
              rows={5}
              placeholder={t('questions.contentPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">{t('questions.saveAsKnowledgeTags')}</label>
            <input
              type="text"
              value={saveTags}
              onChange={(e) => setSaveTags(e.target.value)}
              placeholder={t('common.commaSeparated')}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-violet-500"
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">{t('questions.saveAsKnowledgeCategory')}</label>
            <input
              type="text"
              value={saveCategory}
              onChange={(e) => setSaveCategory(e.target.value)}
              placeholder={t('questions.categoryPlaceholder')}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-violet-500"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button type="button" size="xs" variant="primary" disabled={saving || !saveTopic.trim()} onClick={handleSaveAsKnowledge}>
              {saving ? t('questions.saveAsKnowledgeSaving') : t('common.save')}
            </Button>
            <Button type="button" size="xs" variant="secondary" onClick={() => { setShowSaveForm(false); setSaveContent(defaultContent); }}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AskAgentForm({
  draft,
  setDraft,
  submitting,
  onSubmit,
}: {
  draft: string;
  setDraft: (s: string) => void;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-t border-gray-800 pt-3">
      <label className="block text-xs text-gray-500 mb-1">{t('questions.askAgentLabel')}</label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={t('questions.askAgentPlaceholder')}
          className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500"
        />
        <Button
          type="button"
          variant="primary"
          disabled={submitting || !draft.trim()}
          onClick={onSubmit}
        >
          {submitting ? '...' : t('questions.askAgentSubmit')}
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-gray-600">{t('questions.askAgentHint')}</p>
    </div>
  );
}
