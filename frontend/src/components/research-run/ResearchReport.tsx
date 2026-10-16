import { useTranslation } from 'react-i18next';
import type { ResearchSourceItem } from '../../api/client';
import { citedNumbers, linkCitations, splitReport } from '../../lib/research';
import Markdown from '../Markdown';

/**
 * Bericht mit klickbaren `[n]`. Gibt es eine `sourceList` (neue Recherchen), wird der
 * vom Backend angehängte `## Quellen`-Abschnitt durch eine eigene Liste mit Ankern
 * `#src-n` ersetzt. Ohne `sourceList` (Alt-Einträge, research_save) bleibt der
 * Inhalt unverändert — es gibt dann keine Nummern, auf die man verlinken könnte.
 */
export default function ResearchReport({
  content,
  sourceList,
  legacySources = [],
}: {
  content: string;
  sourceList: ResearchSourceItem[];
  legacySources?: string[];
}) {
  const { t } = useTranslation();
  if (!content) return <p className="text-sm text-gray-500">{t('researchRun.detail.noReport')}</p>;
  if (sourceList.length === 0) {
    return (
      <div className="space-y-6">
        <Markdown className="text-gray-300">{content}</Markdown>
        {legacySources.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold mb-2">{t('researchRun.detail.sources')}</h3>
            <ul className="space-y-1 text-xs">
              {legacySources.map((src, i) => (
                <li key={i}>
                  {/^https?:\/\//i.test(src) ? (
                    <a href={src} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline break-all">{src}</a>
                  ) : (
                    <span className="text-gray-300 break-all">{src}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  const { body } = splitReport(content);
  const cited = new Set(citedNumbers(body));
  let shown = sourceList.filter((s) => cited.has(s.n));
  if (shown.length === 0) shown = sourceList.filter((s) => s.relevant);
  shown = [...shown].sort((a, b) => a.n - b.n);
  const known = new Set(shown.map((s) => s.n));

  return (
    <div className="space-y-6">
      <Markdown className="text-gray-300">{linkCitations(body, known)}</Markdown>
      {shown.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2">{t('researchRun.detail.sources')}</h3>
          <ol className="space-y-1 text-xs">
            {shown.map((s) => (
              <li key={s.n} id={`src-${s.n}`} className="scroll-mt-24 target:bg-violet-900/30 rounded-sm px-1">
                <span className="text-gray-500 mr-1">[{s.n}]</span>
                {s.file ? (
                  <span className="text-gray-300">📎 {s.file} ({t('researchRun.detail.ownFile')})</span>
                ) : s.url && /^https?:\/\//i.test(s.url) ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline break-all">
                    {s.title || s.url}
                  </a>
                ) : (
                  <span className="text-gray-300 break-all">{s.title || s.url}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
