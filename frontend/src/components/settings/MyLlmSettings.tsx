import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, UserLlmConfig } from '../../api/client';
import { isRecord, isUnknownArray } from '../../lib/narrow';
import Button from '../ui/Button';
import ConfirmButton from '../ui/ConfirmButton';
import { FormInput, SecretInput } from '../ui/FormField';
import { SettingsActions, SettingsTabHeader } from '../ui/SettingsShell';

export default function MyLlmSettings() {
  const { t } = useTranslation();

  const [llmConfig, setLlmConfig] = useState<UserLlmConfig>({
    mode: 'server',
    endpoint: '',
    model: '',
    apiKey: '',
    fallbackEnabled: false,
  });
  // Startet auf `true`: mit `false` steht das Formular für die Dauer des
  // Profil-Requests auf den Defaults — wer "browser" gespeichert hat, sieht
  // solange fälschlich "server" ausgewählt und leere Felder.
  const [llmLoading, setLlmLoading] = useState(true);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmSavedMsg, setLlmSavedMsg] = useState(false);
  const [llmHasStoredKey, setLlmHasStoredKey] = useState(false);
  const [llmTestState, setLlmTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [llmTestMessage, setLlmTestMessage] = useState<string>('');
  const [llmSaveError, setLlmSaveError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const profile = await api.profile.get();
        const cfg = profile.llmConfig || {};
        const storedKey = cfg.apiKey === '***';
        setLlmHasStoredKey(storedKey);
        setLlmConfig({
          mode: (cfg.mode) || 'server',
          endpoint: cfg.endpoint || '',
          model: cfg.model || '',
          apiKey: '',
          fallbackEnabled: !!cfg.fallbackEnabled,
        });
        setLlmTestState('idle');
        setLlmTestMessage('');
      } catch { /* ignore */ }
      setLlmLoading(false);
    })();
  }, []);

  const saveLlmConfig = async () => {
    setLlmSaving(true);
    setLlmSaveError(null);
    try {
      const payload: UserLlmConfig = {
        mode: llmConfig.mode,
        endpoint: llmConfig.endpoint?.trim() || '',
        model: llmConfig.model?.trim() || '',
        fallbackEnabled: !!llmConfig.fallbackEnabled,
      };
      const trimmedKey = llmConfig.apiKey?.trim();
      if (trimmedKey) {
        payload.apiKey = trimmedKey;
      }
      const updated = await api.profile.update({ llmConfig: payload });
      const stored = updated.llmConfig?.apiKey === '***';
      setLlmHasStoredKey(stored);
      setLlmConfig((prev) => ({ ...prev, apiKey: '' }));
      setLlmSavedMsg(true);
      setTimeout(() => setLlmSavedMsg(false), 3000);
    } catch (err) {
      setLlmSaveError(err instanceof Error ? err.message : 'Error');
    }
    setLlmSaving(false);
  };

  const clearStoredApiKey = async () => {
    setLlmSaving(true);
    try {
      await api.profile.update({ llmConfig: { apiKey: '' } });
      setLlmHasStoredKey(false);
      setLlmConfig((prev) => ({ ...prev, apiKey: '' }));
    } catch (err) {
      setLlmSaveError(err instanceof Error ? err.message : 'Error');
    }
    setLlmSaving(false);
  };

  const testLlmEndpoint = async () => {
    const endpoint = llmConfig.endpoint?.trim();
    if (!endpoint) return;
    setLlmTestState('testing');
    setLlmTestMessage('');
    try {
      const base = endpoint.replace(/\/+$/, '');
      const url = `${base}/v1/models`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      const trimmedKey = llmConfig.apiKey?.trim();
      if (trimmedKey) {
        headers.Authorization = `Bearer ${trimmedKey}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      // Fremder, vom Nutzer konfigurierter Endpunkt — die Form der Antwort ist
      // nicht zugesichert, deshalb geprüft statt behauptet.
      const data: unknown = await res.json();
      const models = isRecord(data) ? data.data : undefined;
      const count = isUnknownArray(models) ? models.length : 0;
      setLlmTestState('ok');
      setLlmTestMessage(t('settings.myLlmTestOk', { count }));
    } catch (err) {
      setLlmTestState('fail');
      const message = err instanceof Error ? err.message : String(err);
      setLlmTestMessage(t('settings.myLlmTestFail', { error: message }));
    }
  };

  return (
    <div className="space-y-4">
      <SettingsTabHeader description={t('settings.myLlmDescription')} className="mb-0" />

      {typeof window !== 'undefined' && window.location.protocol === 'https:' && (
        <div className="bg-amber-900/30 border border-amber-700/60 text-amber-200 text-sm px-3 py-2 rounded">
          {t('settings.myLlmMixedContentWarning')}
        </div>
      )}

      {llmLoading ? (
        <div className="text-gray-500 text-sm">{t('common.loading')}</div>
      ) : (
        <div className="space-y-4 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              {t('settings.myLlmMode')}
            </label>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="radio"
                  name="llm-mode"
                  checked={llmConfig.mode === 'server'}
                  onChange={() => {
                    setLlmConfig((prev) => ({ ...prev, mode: 'server' }));
                    setLlmSavedMsg(false);
                  }}
                  className="mt-0.5 accent-cyan-500"
                />
                <span>{t('settings.myLlmModeServer')}</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="radio"
                  name="llm-mode"
                  checked={llmConfig.mode === 'browser'}
                  onChange={() => {
                    setLlmConfig((prev) => ({ ...prev, mode: 'browser' }));
                    setLlmSavedMsg(false);
                  }}
                  className="mt-0.5 accent-cyan-500"
                />
                <span>{t('settings.myLlmModeBrowser')}</span>
              </label>
            </div>
          </div>

          {llmConfig.mode === 'browser' && (
            <>
              <FormInput
                label={t('settings.myLlmEndpoint')}
                type="url"
                value={llmConfig.endpoint || ''}
                onChange={(e) => {
                  setLlmConfig((prev) => ({ ...prev, endpoint: e.target.value }));
                  setLlmSavedMsg(false);
                  setLlmTestState('idle');
                }}
                placeholder="http://localhost:1234"
                className="font-mono"
                helpText={t('settings.myLlmEndpointHint')}
              />

              <FormInput
                label={t('settings.myLlmModel')}
                type="text"
                value={llmConfig.model || ''}
                onChange={(e) => {
                  setLlmConfig((prev) => ({ ...prev, model: e.target.value }));
                  setLlmSavedMsg(false);
                }}
                placeholder="google/gemma-3-4b"
                className="font-mono"
                helpText={t('settings.myLlmModelHint')}
              />

              <div className="flex items-end gap-2">
                <SecretInput
                  fieldClassName="flex-1 min-w-0"
                  label={t('settings.myLlmApiKey')}
                  value={llmConfig.apiKey || ''}
                  onChange={(e) => {
                    setLlmConfig((prev) => ({ ...prev, apiKey: e.target.value }));
                    setLlmSavedMsg(false);
                  }}
                  placeholder={llmHasStoredKey ? t('settings.myLlmApiKeyStored') : ''}
                  className="font-mono"
                  helpText={t('settings.myLlmApiKeyHint')}
                />
                {llmHasStoredKey && (
                  <ConfirmButton
                    variant="secondary"
                    size="sm"
                    label={t('settings.myLlmApiKeyClear')}
                    onConfirm={clearStoredApiKey}
                    disabled={llmSaving}
                  />
                )}
              </div>

              <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={!!llmConfig.fallbackEnabled}
                  onChange={(e) => {
                    setLlmConfig((prev) => ({ ...prev, fallbackEnabled: e.target.checked }));
                    setLlmSavedMsg(false);
                  }}
                  className="mt-0.5 w-4 h-4 accent-cyan-500"
                />
                <span>
                  <div>{t('settings.myLlmFallback')}</div>
                  <div className="text-xs text-gray-500">{t('settings.myLlmFallbackHint')}</div>
                </span>
              </label>

              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { void testLlmEndpoint(); }}
                  disabled={!llmConfig.endpoint?.trim() || llmTestState === 'testing'}
                >
                  {llmTestState === 'testing' ? '...' : t('settings.myLlmTest')}
                </Button>
                {llmTestState === 'ok' && <span className="text-green-400 text-sm">✓ {llmTestMessage}</span>}
                {llmTestState === 'fail' && <span className="text-red-400 text-sm">✗ {llmTestMessage}</span>}
              </div>
            </>
          )}

          <SettingsActions className="mt-0 border-t border-gray-800 pt-3">
            <Button variant="primary" size="lg" onClick={() => { void saveLlmConfig(); }} disabled={llmSaving}>
              {llmSaving ? t('common.saving') : t('common.save')}
            </Button>
            {llmSavedMsg && <span className="text-green-400 text-sm">✓ {t('settings.myLlmSaved')}</span>}
            {llmSaveError && <span className="text-red-400 text-sm">✗ {llmSaveError}</span>}
          </SettingsActions>
        </div>
      )}
    </div>
  );
}
