import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ChatConfig } from '../../api/client';
import Button from '../ui/Button';
import { FormInput } from '../ui/FormField';
import { SettingsActions, SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

export default function ChatLlmSettings() {
  const { t } = useTranslation();

  const [chatConfig, setChatConfig] = useState<ChatConfig>({
    enabled: true,
    endpoints: [],
    temperature: 0.7,
    maxTokens: 2048,
    topK: 6,
    historyLimit: 10,
    toolsEnabled: false,
    toolsAllowlist: [],
    toolsMaxIterations: 5,
  });
  // Startet auf `true`: mit `false` rendert der erste Frame die Formularwerte
  // aus den Defaults oben statt der gespeicherten Konfiguration.
  const [chatLoading, setChatLoading] = useState(true);
  const [chatSaving, setChatSaving] = useState(false);
  const [chatSavedMsg, setChatSavedMsg] = useState(false);
  const [chatSaveError, setChatSaveError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.chat.getConfig();
        setChatConfig(cfg);
      } catch { /* ignore */ }
      setChatLoading(false);
    })();
  }, []);

  const saveChatConfig = async () => {
    setChatSaving(true);
    setChatSaveError(null);
    try {
      // Endpoints are no longer editable here (see LlmEndpointsSettings) but
      // `endpoints` is a required field on UpdateChatConfigDto, so we pass the
      // last-loaded value through untouched. Strip `hasApiKey` (response-only
      // metadata). `apiKey` semantics per-field: undefined → keep stored,
      // "" → delete, string → update (see ChatLlmService.setEndpoints).
      const sanitizedEndpoints = chatConfig.endpoints.map(({ hasApiKey: _omit, ...rest }) => {
        void _omit;
        return rest;
      });
      const payload = {
        enabled: chatConfig.enabled,
        endpoints: sanitizedEndpoints,
        temperature: chatConfig.temperature,
        maxTokens: chatConfig.maxTokens,
        topK: chatConfig.topK,
        historyLimit: chatConfig.historyLimit,
        toolsEnabled: chatConfig.toolsEnabled,
        toolsAllowlist: chatConfig.toolsAllowlist,
        toolsMaxIterations: chatConfig.toolsMaxIterations,
      };
      const saved = await api.chat.updateConfig(payload);
      setChatConfig(saved);
      setChatSavedMsg(true);
      setTimeout(() => setChatSavedMsg(false), 3000);
    } catch (err) {
      setChatSaveError(err instanceof Error ? err.message : 'Error');
    }
    setChatSaving(false);
  };

  return (
    <>
      <SettingsTabHeader description={t('settings.chatDescription')} />

      {chatLoading ? (
        <div className="text-gray-500 py-10 text-center">{t('common.loading')}</div>
      ) : (
        <div className="space-y-6">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={chatConfig.enabled !== false}
                onChange={(e) => {
                  setChatConfig((prev) => ({ ...prev, enabled: e.target.checked }));
                  setChatSavedMsg(false);
                }}
                className="mt-1 w-4 h-4 accent-violet-600"
              />
              <div>
                <div className="text-sm font-medium text-gray-200">{t('settings.chatFeatureEnabled')}</div>
                <div className="text-xs text-gray-500 mt-0.5">{t('settings.chatFeatureEnabledHint')}</div>
              </div>
            </label>
          </div>

          <SettingsSection title={t('settings.chatAdvancedTitle')} description={t('settings.chatAdvancedDescription')}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <FormInput
                label={t('settings.chatTemperature')}
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={chatConfig.temperature ?? 0.7}
                onChange={(e) => { setChatConfig((prev) => ({ ...prev, temperature: parseFloat(e.target.value) })); setChatSavedMsg(false); }}
              />
              <FormInput
                label={t('settings.chatMaxTokens')}
                type="number"
                min="1"
                value={chatConfig.maxTokens ?? 2048}
                onChange={(e) => { setChatConfig((prev) => ({ ...prev, maxTokens: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
              />
              <FormInput
                label={t('settings.chatTopK')}
                type="number"
                min="1"
                max="20"
                value={chatConfig.topK ?? 6}
                onChange={(e) => { setChatConfig((prev) => ({ ...prev, topK: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
              />
              <FormInput
                label={t('settings.chatHistoryLimit')}
                type="number"
                min="1"
                max="50"
                value={chatConfig.historyLimit ?? 10}
                onChange={(e) => { setChatConfig((prev) => ({ ...prev, historyLimit: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
              />
            </div>
          </SettingsSection>

          <SettingsSection title={t('settings.chatToolsTitle')} description={t('settings.chatToolsDescription')}>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={chatConfig.toolsEnabled ?? false}
                  onChange={(e) => { setChatConfig((prev) => ({ ...prev, toolsEnabled: e.target.checked })); setChatSavedMsg(false); }}
                  className="w-4 h-4 accent-violet-600"
                />
                <span className="text-sm font-medium text-gray-200">{t('settings.chatToolsEnable')}</span>
              </label>
              <FormInput
                fieldClassName="w-32"
                label={t('settings.chatToolsMaxIterations')}
                type="number"
                min="1"
                max="10"
                value={chatConfig.toolsMaxIterations ?? 5}
                onChange={(e) => { setChatConfig((prev) => ({ ...prev, toolsMaxIterations: parseInt(e.target.value, 10) })); setChatSavedMsg(false); }}
                disabled={!chatConfig.toolsEnabled}
              />
            </div>

            <div className="mt-3 bg-amber-900/20 border border-amber-800/40 rounded px-3 py-2 text-xs text-amber-200">
              ⚠ {t('settings.chatToolsHint')}
            </div>

            {chatConfig.toolsEnabled && chatConfig.toolGroups && (() => {
              const allowlist = chatConfig.toolsAllowlist ?? [];
              const writeTools = new Set(chatConfig.writeTools ?? []);
              const activeWriteCount = allowlist.filter((tool) => writeTools.has(tool)).length;
              return (
                <div className="space-y-3 pt-1">
                  <div className="text-xs text-gray-400 font-medium">{t('settings.chatToolsAllowlist')}</div>

                  {activeWriteCount > 0 && (
                    <div className="bg-red-900/20 border border-red-800/50 rounded px-3 py-2 text-xs text-red-200">
                      ⚠ {t('settings.chatToolsWriteBanner', { count: activeWriteCount })}
                    </div>
                  )}

                  {Object.entries(chatConfig.toolGroups).map(([groupKey, tools]) => {
                    const isWriteGroup = groupKey.endsWith('_write');
                    const allOn = tools.every((tool) => allowlist.includes(tool));
                    const someOn = tools.some((tool) => allowlist.includes(tool));
                    const toggleGroup = () => {
                      if (!allOn && isWriteGroup) {
                        const msg = t('settings.chatToolsSelectAllWriteConfirm', { count: tools.length });
                        if (!window.confirm(msg)) return;
                      }
                      const next = allOn
                        ? allowlist.filter((a) => !tools.includes(a))
                        : Array.from(new Set([...allowlist, ...tools]));
                      setChatConfig((prev) => ({ ...prev, toolsAllowlist: next }));
                      setChatSavedMsg(false);
                    };
                    const toggleTool = (tool: string) => {
                      const next = allowlist.includes(tool)
                        ? allowlist.filter((a) => a !== tool)
                        : [...allowlist, tool];
                      setChatConfig((prev) => ({ ...prev, toolsAllowlist: next }));
                      setChatSavedMsg(false);
                    };
                    const boxCls = isWriteGroup
                      ? 'bg-red-950/20 border-red-900/50'
                      : 'bg-gray-800 border-gray-700';
                    return (
                      <div key={groupKey} className={`border rounded p-2.5 ${boxCls}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-xs font-medium text-gray-300 flex items-center gap-2">
                            {t(`settings.chatToolsGroup_${groupKey}`)}
                            {isWriteGroup && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-900/60 text-red-200 border border-red-800 uppercase tracking-wide">
                                {t('settings.chatToolsWriteBadge')}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={toggleGroup}
                            className={`text-xs ${isWriteGroup ? 'text-red-300 hover:text-red-200' : 'text-cyan-400 hover:text-cyan-300'}`}
                          >
                            {allOn ? t('settings.chatToolsSelectNone') : t('settings.chatToolsSelectAll')}
                            <span className="text-gray-500 ml-1">({tools.filter((tool) => allowlist.includes(tool)).length}/{tools.length})</span>
                          </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                          {tools.map((tool) => (
                            <label
                              key={tool}
                              className={`flex items-center gap-1.5 cursor-pointer text-xs hover:text-gray-200 ${
                                isWriteGroup ? 'text-red-200/80' : 'text-gray-400'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={allowlist.includes(tool)}
                                onChange={() => toggleTool(tool)}
                                className={`w-3.5 h-3.5 ${isWriteGroup ? 'accent-red-600' : 'accent-violet-600'}`}
                              />
                              <span className="font-mono">{tool}</span>
                            </label>
                          ))}
                        </div>
                        {!allOn && someOn && (
                          <div className="text-xs text-gray-600 mt-1.5">
                            {tools.filter((tool) => allowlist.includes(tool)).length} / {tools.length}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </SettingsSection>

          <SettingsActions className="mt-0">
            <Button variant="primary" size="lg" onClick={() => { void saveChatConfig(); }} disabled={chatSaving}>
              {chatSaving ? t('common.saving') : t('common.save')}
            </Button>
            {chatSavedMsg && <span className="text-green-400 text-sm">✓ {t('settings.chatSaved')}</span>}
            {chatSaveError && <span className="text-red-400 text-sm">✗ {chatSaveError}</span>}
          </SettingsActions>
        </div>
      )}
    </>
  );
}
