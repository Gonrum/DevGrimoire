import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';

interface PendingQuestion {
  _id: string;
  question: string;
  options: string[];
  context?: string;
  todoId?: string;
  projectId?: string;
  expiresAt: string;
  status: string;
}

export default function QuestionDialog() {
  const { t } = useTranslation();
  const { getAccessToken, authEnabled } = useAuth();
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const fetchPending = useCallback(async () => {
    const token = getAccessToken();
    if (authEnabled && !token) return;

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch('/api/questions/pending', { headers });
      if (!res.ok) return;
      const data: PendingQuestion[] = await res.json();
      setQuestions((prev) => {
        // Play sound if there are new questions
        const prevIds = new Set(prev.map((q) => q._id));
        const hasNew = data.some((q) => !prevIds.has(q._id));
        if (hasNew && prev.length > 0) {
          try {
            if (!audioRef.current) {
              audioRef.current = new Audio('/notification.mp3');
              audioRef.current.volume = 0.3;
            }
            audioRef.current.play().catch(() => {});
          } catch { /* no audio */ }
        }
        return data;
      });
    } catch { /* ignore */ }
  }, [getAccessToken, authEnabled]);

  // Poll for pending questions every 3 seconds
  useEffect(() => {
    fetchPending();
    const interval = setInterval(fetchPending, 3000);
    return () => clearInterval(interval);
  }, [fetchPending]);

  const submitAnswer = useCallback(
    async (questionId: string, answer: string) => {
      setSubmitting(true);
      try {
        const token = getAccessToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`/api/questions/${questionId}/answer`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ answer }),
        });
        if (res.ok) {
          setQuestions((prev) => prev.filter((q) => q._id !== questionId));
          setFreeText('');
        }
      } catch {
        // Error handling
      } finally {
        setSubmitting(false);
      }
    },
    [getAccessToken],
  );

  if (questions.length === 0) return null;

  const current = questions[0];
  const remaining = Math.max(
    0,
    Math.floor((new Date(current.expiresAt).getTime() - Date.now()) / 1000),
  );
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-gray-900 border border-violet-500/50 rounded-xl shadow-2xl shadow-violet-500/10 max-w-lg w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-violet-500/10 border-b border-violet-500/30 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-violet-400">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-sm font-medium text-violet-300">
              {t('question.title', 'Agent-Rückfrage')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {questions.length > 1 && (
              <span className="text-xs text-gray-500">
                +{questions.length - 1} {t('question.more', 'weitere')}
              </span>
            )}
            <span className="text-xs text-gray-500 tabular-nums">
              {minutes}:{seconds.toString().padStart(2, '0')}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {current.context && (
            <p className="text-xs text-gray-500 mb-2">{current.context}</p>
          )}
          <p className="text-gray-200 text-sm leading-relaxed">
            {current.question}
          </p>
        </div>

        {/* Actions */}
        <div className="px-5 pb-4">
          {current.options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {current.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={submitting}
                  onClick={() => submitAnswer(current._id, option)}
                  className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
                >
                  {option}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && freeText.trim()) {
                    submitAnswer(current._id, freeText.trim());
                  }
                }}
                placeholder={t('question.placeholder', 'Antwort eingeben...')}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-violet-500"
                autoFocus
              />
              <button
                type="button"
                disabled={submitting || !freeText.trim()}
                onClick={() => submitAnswer(current._id, freeText.trim())}
                className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                {t('question.send', 'Senden')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
