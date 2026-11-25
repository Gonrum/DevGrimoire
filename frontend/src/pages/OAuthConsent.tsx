import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, type OAuthConsentRequest, type Project } from '../api/client';
import Button from '../components/ui/Button';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { useAuth } from '../hooks/useAuth';
import { errorMessage } from '../lib/narrow';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; request: OAuthConsentRequest }
  | { kind: 'expired' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

type Decision = { approve: boolean; projectIds?: string[] };

/**
 * The decision may have reached the backend even though no answer came
 * back: a failed fetch (TypeError, aborted connection) or a gateway error.
 */
function isLostResponse(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 502 || err.status === 503 || err.status === 504;
  return true;
}

/**
 * Consent page of the MCP OAuth flow (`/authorize` redirects here with
 * `?request=<id>`). It sits behind the normal login gate, so an anonymous
 * visitor sees the login form on this very URL and lands back here.
 *
 * The browser only ever leaves for the `redirectUrl` the backend returns.
 */
export default function OAuthConsent() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const requestId = params.get('request') ?? '';

  const [state, setState] = useState<LoadState>(requestId ? { kind: 'loading' } : { kind: 'expired' });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The decision whose response got lost; "try again" repeats exactly this
  // one (the backend accepts a repeat only with the same choice).
  const [lost, setLost] = useState<Decision | null>(null);

  useEffect(() => {
    if (!requestId) return;
    let cancelled = false;
    async function run() {
      try {
        const [request, list] = await Promise.all([
          api.oauth.getRequest(requestId),
          api.projects.list().then(
            (items) => ({ items, failed: false }),
            () => ({ items: [] as Project[], failed: true }),
          ),
        ]);
        if (cancelled) return;
        setProjects(list.items);
        setProjectsFailed(list.failed);
        setState({ kind: 'ready', request });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'expired' });
        else if (err instanceof ApiError && err.status === 403) setState({ kind: 'forbidden' });
        else setState({ kind: 'error', message: errorMessage(err) });
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [requestId]);

  const toggle = (id: string) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const send = async (decision: Decision) => {
    setSubmitting(true);
    setSubmitError(null);
    setLost(null);
    try {
      let result: { redirectUrl: string };
      try {
        result = await api.oauth.decide(requestId, decision);
      } catch (err) {
        if (!isLostResponse(err)) throw err;
        // The backend may have decided already; it accepts one repeat of
        // the same decision for a short while.
        result = await api.oauth.decide(requestId, decision);
      }
      window.location.assign(result.redirectUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: 'expired' });
      } else if (isLostResponse(err)) {
        setLost(decision);
      } else {
        setSubmitError(t('oauthConsent.decideFailed', { message: errorMessage(err) }));
      }
      setSubmitting(false);
    }
  };

  const decide = (approve: boolean) =>
    send({ approve, ...(approve && selected.length > 0 ? { projectIds: selected } : {}) });

  let body: React.ReactNode;
  if (state.kind === 'loading') {
    body = <LoadingText />;
  } else if (state.kind === 'expired') {
    body = (
      <>
        <h1 className="text-lg font-semibold">{t('oauthConsent.expiredTitle')}</h1>
        <p className="text-sm text-gray-400">{requestId ? t('oauthConsent.expired') : t('oauthConsent.missingId')}</p>
      </>
    );
  } else if (state.kind === 'forbidden') {
    body = <p className="text-sm text-red-400">{t('oauthConsent.forbidden')}</p>;
  } else if (state.kind === 'error') {
    body = <p className="text-sm text-red-400">{t('oauthConsent.loadFailed', { message: state.message })}</p>;
  } else {
    const { request } = state;
    body = (
      <>
        <h1 className="text-lg font-semibold">{t('oauthConsent.title')}</h1>
        <p className="text-sm text-gray-300">
          <Trans
            i18nKey="oauthConsent.intro"
            components={{
              // Attacker-controlled names go in as React children, never as
              // i18n interpolation values (those are not escaped).
              client: <strong className="text-gray-100">{request.clientName ?? t('oauthConsent.unnamedClient')}</strong>,
              user: <strong className="text-gray-100">{user?.username ?? ''}</strong>,
            }}
          />
        </p>

        <div className="bg-gray-800 border border-yellow-700/60 rounded-sm px-4 py-3 space-y-1">
          <div className="text-xs text-gray-400">{t('oauthConsent.redirectTo')}</div>
          <div className="text-xl font-bold text-yellow-300 break-all">{request.redirectHost}</div>
          <div className="text-xs text-gray-500 break-all">{t('oauthConsent.redirectUri', { uri: request.redirectUri })}</div>
        </div>
        <p className="text-xs text-yellow-500">{t('oauthConsent.warning')}</p>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-300">{t('oauthConsent.restrict')}</legend>
          <p className="text-xs text-gray-500">{t('oauthConsent.restrictHint')}</p>
          {projectsFailed ? (
            <p className="text-xs text-red-400">{t('oauthConsent.projectsFailed')}</p>
          ) : projects.length === 0 ? (
            <p className="text-xs text-gray-500">{t('oauthConsent.noProjects')}</p>
          ) : (
            <div className="max-h-60 overflow-y-auto space-y-1 border border-gray-800 rounded-sm p-2">
              {projects.map((p) => (
                <label key={p._id} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(p._id)}
                    onChange={() => toggle(p._id)}
                    disabled={submitting || lost !== null}
                  />
                  <span className="truncate">{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {lost && (
          <div className="bg-red-900/20 border border-red-800 rounded-sm px-3 py-2 text-sm text-red-400 flex items-center justify-between gap-2">
            <span>{t('oauthConsent.responseLost')}</span>
            <Button variant="secondary" disabled={submitting} onClick={() => { void send(lost); }}>
              {t('oauthConsent.retry')}
            </Button>
          </div>
        )}

        {submitError && (
          <div className="bg-red-900/20 border border-red-800 rounded-sm px-3 py-2 text-sm text-red-400">{submitError}</div>
        )}

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" disabled={submitting || lost !== null} onClick={() => { void decide(false); }}>
            {t('oauthConsent.deny')}
          </Button>
          <Button variant="primary" disabled={submitting || lost !== null} onClick={() => { void decide(true); }}>
            {submitting ? t('oauthConsent.working') : t('oauthConsent.allow')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="max-w-xl mx-auto mt-8 bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
      {body}
    </div>
  );
}
