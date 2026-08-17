import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';

interface OnboardingBannerProps {
  /** Switch to a tab by key. Lets the user jump into the relevant section. */
  onJumpTo: (tab: string) => void;
}

interface Status {
  chatLlm: boolean | null;
  rag: boolean | null;
  replication: boolean | null;
}

/**
 * T-328: First-run guidance. We probe the three configuration corners that
 * matter and surface a banner only when an *essential* one is missing
 * (chat-LLM or RAG). Replication is informational — shown but doesn't
 * trigger the banner on its own.
 */
export default function OnboardingBanner({ onJumpTo }: OnboardingBannerProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>({ chatLlm: null, rag: null, replication: null });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // T-Task17: chat/RAG endpoints now live in the central LLM-Endpoints
      // registry (purposes 'chat' / 'embedding') rather than the legacy
      // per-feature config endpoints, which the runtime no longer reads.
      const [endpoints, repl] = await Promise.all([
        api.llmEndpoints.list().catch(() => null),
        api.replication.getConfig().then((r) => r.role !== 'standalone').catch(() => null),
      ]);
      if (cancelled) return;
      const chat = endpoints ? endpoints.some((e) => e.purposes.includes('chat')) : null;
      const rag = endpoints ? endpoints.some((e) => e.purposes.includes('embedding')) : null;
      setStatus({ chatLlm: chat, rag, replication: repl });
    })();
    return () => { cancelled = true; };
  }, []);

  // Essentials are chat-LLM + RAG. Hide the banner once both are configured;
  // replication's standalone state is fine.
  const essentialsDone = status.chatLlm === true && status.rag === true;
  if (essentialsDone) return null;

  // Still loading — render nothing rather than flashing a "you need to
  // configure this" warning that disappears half a second later.
  if (status.chatLlm === null || status.rag === null) return null;

  const rows: Array<{ key: keyof Status; tab: string; label: string; ok: boolean | null }> = [
    { key: 'chatLlm', tab: 'llmEndpoints', label: t('settings.onboardingChatLlm'), ok: status.chatLlm },
    { key: 'rag', tab: 'llmEndpoints', label: t('settings.onboardingRag'), ok: status.rag },
    { key: 'replication', tab: 'replication', label: t('settings.onboardingReplication'), ok: status.replication },
  ];

  return (
    <div className="mb-4 rounded-lg border border-cyan-800 bg-cyan-950/30 p-4">
      <h3 className="mb-1 text-sm font-semibold text-cyan-200">{t('settings.onboardingTitle')}</h3>
      <p className="mb-3 text-xs text-cyan-100/80">{t('settings.onboardingIntro')}</p>
      <ul className="space-y-1.5">
        {rows.map((row) => {
          const icon = row.ok === true ? '✓' : row.ok === false ? '✗' : '○';
          const iconColor = row.ok === true ? 'text-green-400' : row.ok === false ? 'text-amber-400' : 'text-gray-500';
          return (
            <li key={row.key} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 font-mono ${iconColor}`}>{icon}</span>
              <span className="flex-1 text-gray-200">{row.label}</span>
              {row.ok !== true && (
                <button
                  type="button"
                  onClick={() => onJumpTo(row.tab)}
                  className="shrink-0 rounded bg-cyan-800/60 px-2 py-0.5 text-cyan-100 hover:bg-cyan-700"
                >
                  {t('settings.onboardingGoto')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
