import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CaseSensitive, Regex } from 'lucide-react';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/narrow';
import { ideApi, type IdeSearchMatch } from './ide-api';
import { useIdeStore } from './ide-store';

interface SearchResult {
  matches: IdeSearchMatch[];
  truncated: boolean;
  engine?: 'rg' | 'grep';
}

function splitGlobs(value: string): string[] | undefined {
  const globs = value.split(',').map((g) => g.trim()).filter((g) => g !== '');
  return globs.length > 0 ? globs : undefined;
}

const toggleClass = (on: boolean): string =>
  `shrink-0 rounded-sm p-1.5 ${on ? 'bg-cyan-400/15 text-cyan-400' : 'text-gray-400 hover:bg-gray-800'}`;
const inputClass =
  'min-w-0 w-full rounded-sm border border-gray-700 bg-gray-800 px-2 py-1 text-gray-200 outline-none focus:border-cyan-400';

/** Workspace-wide text search. A newer search discards the response of an older one (client-side only). */
export function SearchPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const openFileAt = useIdeStore((s) => s.openFileAt);
  const { showError } = useToast();
  const noteApiError = useIdeStore((s) => s.noteApiError);
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (query === '') return;
    const seq = ++requestSeq.current;
    setBusy(true);
    setError(null);
    ideApi
      .search(workspaceId, {
        query,
        regex,
        caseSensitive,
        include: splitGlobs(include),
        exclude: splitGlobs(exclude),
      })
      .then(
        (res) => {
          if (seq !== requestSeq.current) return;
          setResult(res);
          setBusy(false);
        },
        (err: unknown) => {
          if (seq !== requestSeq.current) return;
          noteApiError(err);
          setResult(null);
          setError(errorMessage(err, t('ide.searchFailed')));
          setBusy(false);
        },
      );
  };

  const groups = useMemo(() => {
    const byPath = new Map<string, IdeSearchMatch[]>();
    for (const match of result?.matches ?? []) {
      const list = byPath.get(match.path);
      if (list) list.push(match);
      else byPath.set(match.path, [match]);
    }
    return [...byPath.entries()];
  }, [result]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2 text-xs">
      <form className="flex flex-col gap-1.5" onSubmit={onSubmit}>
        <div className="flex items-center gap-1">
          <input
            className={inputClass}
            placeholder={t('ide.searchPlaceholder')}
            aria-label={t('ide.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            title={t('ide.searchRegex')}
            aria-label={t('ide.searchRegex')}
            aria-pressed={regex}
            className={toggleClass(regex)}
            onClick={() => setRegex((v) => !v)}
          >
            <Regex size={14} />
          </button>
          <button
            type="button"
            title={t('ide.searchCase')}
            aria-label={t('ide.searchCase')}
            aria-pressed={caseSensitive}
            className={toggleClass(caseSensitive)}
            onClick={() => setCaseSensitive((v) => !v)}
          >
            <CaseSensitive size={14} />
          </button>
        </div>
        <input
          className={`${inputClass} font-mono`}
          placeholder={t('ide.searchInclude')}
          aria-label={t('ide.searchInclude')}
          value={include}
          onChange={(e) => setInclude(e.target.value)}
        />
        <input
          className={`${inputClass} font-mono`}
          placeholder={t('ide.searchExclude')}
          aria-label={t('ide.searchExclude')}
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
        />
        <button
          type="submit"
          disabled={query === ''}
          className="rounded-sm bg-cyan-400/15 px-2 py-1 text-cyan-400 hover:bg-cyan-400/25 disabled:opacity-50"
        >
          {busy ? t('ide.searching') : t('ide.searchRun')}
        </button>
      </form>

      {result?.engine === 'grep' && <p className="text-gray-500">{t('ide.searchGrepHint')}</p>}

      {error && <p className="text-red-400 break-words">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {result !== null && result.matches.length === 0 && !busy && (
          <p className="text-gray-400">{t('ide.searchNoResults')}</p>
        )}
        {groups.map(([path, matches]) => (
          <div key={path} className="mb-2">
            <div className="truncate px-1 font-mono text-gray-200" title={path}>
              {path} <span className="text-gray-500">({matches.length})</span>
            </div>
            {matches.map((match) => (
              <button
                key={`${match.line}:${match.column}`}
                type="button"
                className="flex w-full items-baseline gap-2 truncate rounded-sm px-2 py-0.5 text-left font-mono hover:bg-gray-800"
                onClick={() => {
                  openFileAt(match.path, match.line, match.column).catch((err: unknown) => showError(errorMessage(err)));
                }}
              >
                <span className="shrink-0 text-cyan-400">{match.line}</span>
                <span className="truncate text-gray-400">{match.text.trim()}</span>
              </button>
            ))}
          </div>
        ))}
        {result?.truncated && <p className="text-yellow-400">{t('ide.searchTruncated')}</p>}
      </div>
    </div>
  );
}
