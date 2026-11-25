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
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!requestId) return;
    let cancelled = false;
    async function run() {
      try {
        const [request, list] = await Promise.all([
          api.oauth.getRequest(requestId),
          api.projects.list().catch(() => [] as Project[]),
        ]);
        if (cancelled) return;
        setProjects(list);
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

  const decide = async (approve: boolean) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { redirectUrl } = await api.oauth.decide(requestId, {
        approve,
        ...(approve && selected.length > 0 ? { projectIds: selected } : {}),
      });
      window.location.assign(redirectUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: 'expired' });
      } else {
        setSubmitError(t('oauthConsent.decideFailed', { message: errorMessage(err) }));
      }
      setSubmitting(false);
    }
  };

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
            values={{ client: request.clientName ?? t('oauthConsent.unnamedClient'), user: user?.username ?? '' }}
            components={{ strong: <strong className="text-gray-100" /> }}
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
          {projects.length === 0 ? (
            <p className="text-xs text-gray-500">{t('oauthConsent.noProjects')}</p>
          ) : (
            <div className="max-h-60 overflow-y-auto space-y-1 border border-gray-800 rounded-sm p-2">
              {projects.map((p) => (
                <label key={p._id} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(p._id)}
                    onChange={() => toggle(p._id)}
                    disabled={submitting}
                  />
                  <span className="truncate">{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {submitError && (
          <div className="bg-red-900/20 border border-red-800 rounded-sm px-3 py-2 text-sm text-red-400">{submitError}</div>
        )}

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" disabled={submitting} onClick={() => { void decide(false); }}>
            {t('oauthConsent.deny')}
          </Button>
          <Button variant="primary" disabled={submitting} onClick={() => { void decide(true); }}>
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
