import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import Button from '../ui/Button';
import { SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';
import { Switch } from '../ui/Switch';

interface PushCategory {
  key: string;
  default: boolean;
  group?: string;
}

const PUSH_CATEGORIES: PushCategory[] = [
  { key: 'notify_user', default: true },
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
  const [pushCategories, setPushCategories] = useState<Record<string, boolean>>({});
  const [pushLoading, setPushLoading] = useState(false);
  const [pushSaving, setPushSaving] = useState(false);
  const [dictationEnabled, setDictationEnabled] = useState(
    () => localStorage.getItem('dg_dictation_enabled') !== 'false',
  );

  const loadPushCategories = useCallback(async () => {
    setPushLoading(true);
    try {
      const res = await api.settings.get('notification_push_categories');
      const enabled = (
        res.value ?? PUSH_CATEGORIES.filter((c) => c.default).map((c) => c.key).join(',')
      )
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const state: Record<string, boolean> = {};
      for (const cat of PUSH_CATEGORIES) {
        state[cat.key] = enabled.includes(cat.key);
      }
      setPushCategories(state);
    } catch { /* ignore */ }
    setPushLoading(false);
  }, []);

  useEffect(() => { loadPushCategories(); }, [loadPushCategories]);

  const savePushCategories = async (updated: Record<string, boolean>) => {
    setPushCategories(updated);
    setPushSaving(true);
    try {
      const value = Object.entries(updated).filter(([, v]) => v).map(([k]) => k).join(',');
      await api.settings.set('notification_push_categories', value);
    } catch { /* ignore */ }
    setPushSaving(false);
  };

  const togglePushCategory = (key: string) => {
    savePushCategories({ ...pushCategories, [key]: !pushCategories[key] });
  };

  const toggleAllMcp = () => {
    const mcpKeys = PUSH_CATEGORIES.filter((c) => c.group === 'mcp').map((c) => c.key);
    const allOn = mcpKeys.every((k) => pushCategories[k]);
    const updated = { ...pushCategories };
    for (const k of mcpKeys) updated[k] = !allOn;
    savePushCategories(updated);
  };

  const toggleDictation = (next: boolean) => {
    setDictationEnabled(next);
    localStorage.setItem('dg_dictation_enabled', String(next));
  };

  const resetDictationConsent = () => {
    localStorage.removeItem('speech_consent');
    alert(t('settings.dictationConsentReset') || 'Consent zurückgesetzt');
  };

  const mcpCats = PUSH_CATEGORIES.filter((c) => c.group === 'mcp');
  const allMcpOn = mcpCats.every((c) => pushCategories[c.key]);
  const someMcpOn = mcpCats.some((c) => pushCategories[c.key]);

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

            <section className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900/50">
              <div className="flex items-center justify-between border-b border-gray-800 bg-gray-800/50 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-gray-200">{t('settings.pushGroup_mcp')}</div>
                  <div className="mt-0.5 text-xs text-gray-500">{t('settings.pushGroup_mcp_desc')}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">
                    {someMcpOn
                      ? `${mcpCats.filter((c) => pushCategories[c.key]).length}/${mcpCats.length}`
                      : t('common.none')}
                  </span>
                  <Switch checked={allMcpOn} onChange={() => toggleAllMcp()} disabled={pushSaving} />
                </div>
              </div>
              <div className="divide-y divide-gray-800">
                {mcpCats.map((cat) => (
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
          </>
        )}
      </div>
    </>
  );
}
