import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type NotificationPreferences } from '../../api/client';
import { useToast } from '../Toast';
import Button from '../ui/Button';
import { SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';
import { Switch } from '../ui/Switch';
import { usePushNotifications } from '../../hooks/usePushNotifications';

interface PushCategory {
  key: string;
  default: boolean;
  group?: string;
}

const PUSH_CATEGORIES: PushCategory[] = [
  { key: 'notify_user', default: true },
  // System-Ereignisse (default ON für die hohen-Signal-Trigger)
  { key: 'ask_user', default: true, group: 'system' },
  { key: 'workflow_failure', default: true, group: 'system' },
  { key: 'monitoring_unhealthy', default: true, group: 'system' },
  { key: 'replication_failed', default: true, group: 'system' },
  { key: 'backup_failed', default: true, group: 'system' },
  { key: 'ssh_auth_failure', default: true, group: 'system' },
  { key: 'recurring', default: false, group: 'system' },
  // MCP-Mutationen (alle default OFF — sehr geschwätzig)
  { key: 'mcp_project', default: false, group: 'mcp' },
  { key: 'mcp_todo', default: false, group: 'mcp' },
  { key: 'mcp_milestone', default: false, group: 'mcp' },
  { key: 'mcp_knowledge', default: false, group: 'mcp' },
  { key: 'mcp_changelog', default: false, group: 'mcp' },
  { key: 'mcp_session', default: false, group: 'mcp' },
  { key: 'mcp_research', default: false, group: 'mcp' },
  { key: 'mcp_manual', default: false, group: 'mcp' },
  { key: 'mcp_schema', default: false, group: 'mcp' },
  { key: 'mcp_dependency', default: false, group: 'mcp' },
  { key: 'mcp_environment', default: false, group: 'mcp' },
  { key: 'mcp_secret', default: false, group: 'mcp' },
  { key: 'mcp_feature', default: false, group: 'mcp' },
  { key: 'mcp_soul', default: false, group: 'mcp' },
  { key: 'mcp_commit', default: false, group: 'mcp' },
  { key: 'mcp_system', default: false, group: 'mcp' },
];

export default function NotificationsSettings() {
  const { t } = useTranslation();
  const { showError } = useToast();
  // M-33: ohne Abo auf diesem Gerät kommt keine Push-Nachricht an — der
  // Hook existierte, aber nichts im UI rief ihn auf.
  const push = usePushNotifications();
  // Persönliche Einstellung über /notifications/preferences. Vorher schrieb
  // die Seite die instanzweiten Settings — nur für Admins erlaubt, und der
  // 403 wurde verschluckt: für Nicht-Admins sprang der Schalter um, ohne dass
  // etwas gespeichert wurde. `null` bis geladen.
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [dictationEnabled, setDictationEnabled] = useState(
    () => localStorage.getItem('dg_dictation_enabled') !== 'false',
  );

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.notifications.getPreferences();
        setPrefs({ pushCategories: res.pushCategories, quietHours: res.quietHours });
      } catch (err) {
        showError(err instanceof Error ? err.message : t('settings.notificationPrefsLoadFailed'));
      }
    })();
  }, [showError, t]);

  /** Speichert immer die ganze Einstellung; bei einem Fehler zurück auf den alten Stand. */
  const save = async (next: NotificationPreferences) => {
    const before = prefs;
    setPrefs(next);
    setSaving(true);
    try {
      const res = await api.notifications.setPreferences(next);
      setPrefs({ pushCategories: res.pushCategories, quietHours: res.quietHours });
    } catch (err) {
      setPrefs(before);
      showError(err instanceof Error ? err.message : t('settings.notificationPrefsSaveFailed'));
    }
    setSaving(false);
  };

  const pushCategories: Record<string, boolean> = Object.fromEntries(
    PUSH_CATEGORIES.map((c) => [c.key, prefs?.pushCategories.includes(c.key) ?? false]),
  );
  const quiet = prefs?.quietHours ?? { enabled: false, from: '22:00', to: '07:00', overrides: [] };
  const pushLoading = prefs === null;
  const pushSaving = saving;
  const quietSaving = saving || prefs === null;

  const saveQuietHours = (patch: Partial<NotificationPreferences['quietHours']>) => {
    if (!prefs) return;
    void save({ ...prefs, quietHours: { ...prefs.quietHours, ...patch } });
  };

  const toggleQuietOverride = (key: string) => {
    const next = quiet.overrides.includes(key)
      ? quiet.overrides.filter((k) => k !== key)
      : [...quiet.overrides, key];
    saveQuietHours({ overrides: next });
  };

  const savePushCategories = (updated: Record<string, boolean>) => {
    if (!prefs) return;
    // Kategorien, die diese Seite nicht kennt, bleiben erhalten.
    const known = new Set(PUSH_CATEGORIES.map((c) => c.key));
    const kept = prefs.pushCategories.filter((k) => !known.has(k));
    const enabled = Object.entries(updated).filter(([, v]) => v).map(([k]) => k);
    void save({ ...prefs, pushCategories: [...kept, ...enabled] });
  };

  const togglePushCategory = (key: string) => {
    savePushCategories({ ...pushCategories, [key]: !pushCategories[key] });
  };

  const toggleAllInGroup = (group: string) => {
    const keys = PUSH_CATEGORIES.filter((c) => c.group === group).map((c) => c.key);
    const allOn = keys.every((k) => pushCategories[k]);
    const updated = { ...pushCategories };
    for (const k of keys) updated[k] = !allOn;
    savePushCategories(updated);
  };

  const toggleDictation = (next: boolean) => {
    setDictationEnabled(next);
    localStorage.setItem('dg_dictation_enabled', String(next));
  };

  const resetDictationConsent = () => {
    localStorage.removeItem('speech_consent');
    alert(t('settings.dictationConsentReset'));
  };

  const systemCats = PUSH_CATEGORIES.filter((c) => c.group === 'system');
  const allSystemOn = systemCats.every((c) => pushCategories[c.key]);
  const someSystemOn = systemCats.some((c) => pushCategories[c.key]);
  const mcpCats = PUSH_CATEGORIES.filter((c) => c.group === 'mcp');
  const allMcpOn = mcpCats.every((c) => pushCategories[c.key]);
  const someMcpOn = mcpCats.some((c) => pushCategories[c.key]);

  const renderGroup = (
    title: string,
    desc: string,
    cats: PushCategory[],
    allOn: boolean,
    someOn: boolean,
    toggleAll: () => void,
  ) => (
    <section className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50">
      <div className="flex items-center justify-between border-b border-gray-800 bg-gray-800/50 px-4 py-3">
        <div>
          <div className="text-sm font-medium text-gray-200">{title}</div>
          <div className="mt-0.5 text-xs text-gray-500">{desc}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {someOn
              ? `${cats.filter((c) => pushCategories[c.key]).length}/${cats.length}`
              : t('common.none')}
          </span>
          <Switch checked={allOn} onChange={toggleAll} disabled={pushSaving} />
        </div>
      </div>
      <div className="divide-y divide-gray-800">
        {cats.map((cat) => (
          <div key={cat.key} className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <div className="text-sm text-gray-300">
                {t(`settings.pushCategory_${cat.key}`)}
              </div>
              <div className="mt-0.5 text-xs text-gray-600">
                {t(`settings.pushCategory_${cat.key}_desc`)}
              </div>
            </div>
            <Switch
              checked={pushCategories[cat.key] ?? false}
              onChange={() => togglePushCategory(cat.key)}
              disabled={pushSaving}
            />
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <>
      <SettingsTabHeader description={t('settings.notificationsDescription')} />

      <div className="space-y-4">
        <SettingsSection>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-gray-200">{t('settings.dictationEnabled')}</div>
              <div className="mt-0.5 text-xs text-gray-500">{t('settings.dictationEnabledDesc')}</div>
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={dictationEnabled} onChange={toggleDictation} />
              <Button size="xs" variant="secondary" onClick={resetDictationConsent}>
                {t('settings.dictationResetConsent')}
              </Button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-gray-200">{t('settings.pushDeviceTitle')}</div>
              <div className="mt-0.5 text-xs text-gray-500">
                {!push.supported
                  ? t('settings.pushDeviceUnsupported')
                  : push.permission === 'denied'
                    ? t('settings.pushDeviceDenied')
                    : t('settings.pushDeviceDesc')}
              </div>
              {push.error && <div className="mt-1 text-xs text-red-400">{push.error}</div>}
            </div>
            <Switch
              checked={push.subscribed}
              onChange={() => { void (push.subscribed ? push.unsubscribe() : push.subscribe()); }}
              disabled={!push.supported || push.loading || (push.permission === 'denied' && !push.subscribed)}
            />
          </div>
        </SettingsSection>

        {/* T-340: Quiet Hours */}
        <SettingsSection
          title={t('settings.quietHoursTitle')}
          description={t('settings.quietHoursDescription')}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm text-gray-300">{t('settings.quietHoursEnabled')}</div>
              <Switch
                checked={quiet.enabled}
                onChange={(next) => saveQuietHours({ enabled: next })}
                disabled={quietSaving}
              />
            </div>
            {quiet.enabled && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-gray-500">
                    {t('settings.quietHoursFrom')}
                    <input
                      type="time"
                      value={quiet.from}
                      onChange={(e) => { if (e.target.value) saveQuietHours({ from: e.target.value }); }}
                      disabled={quietSaving}
                      className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-hidden focus:border-violet-500"
                    />
                  </label>
                  <label className="text-xs text-gray-500">
                    {t('settings.quietHoursTo')}
                    <input
                      type="time"
                      value={quiet.to}
                      onChange={(e) => { if (e.target.value) saveQuietHours({ to: e.target.value }); }}
                      disabled={quietSaving}
                      className="mt-1 block w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-hidden focus:border-violet-500"
                    />
                  </label>
                </div>
                <div>
                  <div className="mb-2 text-xs text-gray-500">{t('settings.quietHoursOverrideHint')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {PUSH_CATEGORIES.map((cat) => {
                      const sel = quiet.overrides.includes(cat.key);
                      return (
                        <button
                          key={cat.key}
                          type="button"
                          onClick={() => toggleQuietOverride(cat.key)}
                          disabled={quietSaving}
                          className={`text-xs rounded-full px-2 py-0.5 ${
                            sel ? 'bg-amber-700/60 text-amber-100' : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                          }`}
                        >
                          {t(`settings.pushCategory_${cat.key}`)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </SettingsSection>

        {pushLoading ? (
          <div className="py-10 text-center text-gray-500">{t('common.loading')}</div>
        ) : (
          <>
            {PUSH_CATEGORIES.filter((c) => !c.group).map((cat) => (
              <SettingsSection key={cat.key}>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-gray-200">
                      {t(`settings.pushCategory_${cat.key}`)}
                    </div>
                    <div className="mt-0.5 text-xs text-gray-500">
                      {t(`settings.pushCategory_${cat.key}_desc`)}
                    </div>
                  </div>
                  <Switch
                    checked={pushCategories[cat.key] ?? false}
                    onChange={() => togglePushCategory(cat.key)}
                    disabled={pushSaving}
                  />
                </div>
              </SettingsSection>
            ))}

            {renderGroup(
              t('settings.pushGroup_system'),
              t('settings.pushGroup_system_desc'),
              systemCats,
              allSystemOn,
              someSystemOn,
              () => toggleAllInGroup('system'),
            )}

            {renderGroup(
              t('settings.pushGroup_mcp'),
              t('settings.pushGroup_mcp_desc'),
              mcpCats,
              allMcpOn,
              someMcpOn,
              () => toggleAllInGroup('mcp'),
            )}
          </>
        )}
      </div>
    </>
  );
}
