import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ChatConfig, ChatEndpoint, ChatProvider } from '../../api/client';
import Button from '../ui/Button';
import { FormInput } from '../ui/FormField';
import { SettingsActions, SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';

const CHAT_PROVIDER_DEFAULT_URL: Record<ChatProvider, string> = {
  lmstudio: 'http://localhost:1234',
  'openai-compatible': 'http://localhost:1234',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

const CHAT_PROVIDER_DEFAULT_MODEL: Record<ChatProvider, string> = {
  lmstudio: 'google/gemma-3-4b',
  'openai-compatible': 'google/gemma-3-4b',
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
};

/** API-key expectations per provider. */
const CHAT_PROVIDER_KEY_REQUIRED: Record<ChatProvider, 'none' | 'optional' | 'required'> = {
  lmstudio: 'optional',
  'openai-compatible': 'optional',
  anthropic: 'required',
  openai: 'required',
};

/** Which providers support tool-calling today (see backend TOOL_CAPABLE_PROVIDERS). */
const CHAT_PROVIDER_TOOLS_SUPPORTED: Record<ChatProvider, boolean> = {
  lmstudio: true,
  'openai-compatible': true,
  anthropic: true,
  openai: true,
};

/** Model-name patterns that imply vision support — used to preselect the Vision checkbox. */
const VISION_MODEL_PATTERNS = [
  /claude-3/i,
  /claude-4/i,
  /gpt-4o/i,
  /gpt-4-turbo/i,
  /llava/i,
  /qwen.*-vl/i,
  /gemma-?3/i,
  /pixtral/i,
];

function modelLooksVisionCapable(model: string): boolean {
  return VISION_MODEL_PATTERNS.some((re) => re.test(model));
}

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
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSaving, setChatSaving] = useState(false);
  const [chatSavedMsg, setChatSavedMsg] = useState(false);
  const [chatTestResults, setChatTestResults] = useState<Record<number, { ok: boolean; error?: string; models?: string[] }>>({});
  const [chatSaveError, setChatSaveError] = useState<string | null>(null);

  /** Track which API-key fields are currently visible (toggle show/hide per row). */
  const [chatApiKeyVisible, setChatApiKeyVisible] = useState<Record<number, boolean>>({});

  const loadChatConfig = useCallback(async () => {
    setChatLoading(true);
    try {
      const cfg = await api.chat.getConfig();
      setChatConfig(cfg);
    } catch { /* ignore */ }
    setChatLoading(false);
  }, []);

  useEffect(() => { loadChatConfig(); }, [loadChatConfig]);

  const updateChatEndpoint = (idx: number, patch: Partial<ChatEndpoint>) => {
    setChatConfig((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((e, i) => {
        if (i !== idx) return e;
        const next: ChatEndpoint = { ...e, ...patch };

        // If the provider changed, auto-prefill URL + model when the user hadn't customized them
        // (i.e. the current value still matches one of the known defaults).
        if (patch.provider && patch.provider !== e.provider) {
          const wasDefaultUrl = Object.values(CHAT_PROVIDER_DEFAULT_URL).includes(e.url);
          if (!e.url || wasDefaultUrl) {
            next.url = CHAT_PROVIDER_DEFAULT_URL[patch.provider];
          }
          const wasDefaultModel = Object.values(CHAT_PROVIDER_DEFAULT_MODEL).includes(e.model);
          if (!e.model || wasDefaultModel) {
            next.model = CHAT_PROVIDER_DEFAULT_MODEL[patch.provider];
          }
          // Switching to a provider that doesn't take keys → drop any in-flight apiKey input
          if (CHAT_PROVIDER_KEY_REQUIRED[patch.provider] === 'none') {
            delete next.apiKey;
          }
          // Re-run vision heuristic on the (possibly new) model name
          if (next.visionCapable === undefined) {
            next.visionCapable = modelLooksVisionCapable(next.model);
          }
        }
        // When the user changes the model name, only auto-toggle vision if they
        // haven't explicitly set it — don't stomp on a manual choice.
        if (patch.model !== undefined && patch.model !== e.model && e.visionCapable === undefined) {
          next.visionCapable = modelLooksVisionCapable(patch.model);
        }
        return next;
      }),
    }));
    setChatSavedMsg(false);
  };

  const addChatEndpoint = () => {
    setChatConfig((prev) => ({
      ...prev,
      endpoints: [
        ...prev.endpoints,
        {
          provider: 'lmstudio',
          url: CHAT_PROVIDER_DEFAULT_URL.lmstudio,
          model: CHAT_PROVIDER_DEFAULT_MODEL.lmstudio,
        },
      ],
    }));
    setChatSavedMsg(false);
  };

  const removeChatEndpoint = (idx: number) => {
    setChatConfig((prev) => ({
      ...prev,
      endpoints: prev.endpoints.filter((_, i) => i !== idx),
    }));
    setChatTestResults((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
    setChatSavedMsg(false);
  };

  const testChatEndpoint = async (idx: number) => {
    const endpoint = chatConfig.endpoints[idx];
    if (!endpoint) return;
    try {
      const result = await api.chat.testEndpoint(endpoint);
      setChatTestResults((prev) => ({ ...prev, [idx]: result }));
    } catch (err) {
      setChatTestResults((prev) => ({ ...prev, [idx]: { ok: false, error: err instanceof Error ? err.message : 'Error' } }));
    }
  };

  const saveChatConfig = async () => {
    setChatSaving(true);
    setChatSaveError(null);
    try {
      // Strip `hasApiKey` (response-only metadata). `apiKey` semantics per-field:
      // undefined → keep stored, "" → delete, string → update (see ChatLlmService.setEndpoints).
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

          <SettingsSection
            title={t('settings.chatEndpoints')}
            description={t('settings.chatEndpointsDescription')}
            meta={chatConfig.endpoints.length > 0 ? `${chatConfig.endpoints.length}` : undefined}
          >
            <div className="mb-3 flex justify-end">
              <Button size="sm" onClick={addChatEndpoint}>{t('settings.chatAddEndpoint')}</Button>
            </div>

            {chatConfig.endpoints.length === 0 ? (
              <div className="text-gray-500 text-sm py-4 text-center">{t('settings.chatNoEndpoints')}</div>
            ) : (
              <div className="space-y-3">
                {chatConfig.endpoints.map((endpoint, idx) => {
                  const result = chatTestResults[idx];
                  const keyReq = CHAT_PROVIDER_KEY_REQUIRED[endpoint.provider];
                  const keySupported = keyReq !== 'none';
                  const keyRequired = keyReq === 'required';
                  const isLocal = keyReq === 'none' || keyReq === 'optional';
                  const hasStoredKey = !!endpoint.hasApiKey;
                  const keyVisible = !!chatApiKeyVisible[idx];
                  const toolsSupported = CHAT_PROVIDER_TOOLS_SUPPORTED[endpoint.provider];
                  return (
                    <div key={idx} className="bg-gray-800 border border-gray-700 rounded p-3">
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('settings.chatProvider')}</label>
                          <select
                            value={endpoint.provider}
                            onChange={(e) => updateChatEndpoint(idx, { provider: e.target.value as ChatProvider })}
                            className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
                          >
                            <option value="lmstudio">{t('settings.chatProviderLmStudio')}</option>
                            <option value="openai-compatible">{t('settings.chatProviderOpenAiCompatible')}</option>
                            <option value="anthropic">{t('settings.chatProviderAnthropic')}</option>
                            <option value="openai">{t('settings.chatProviderOpenAi')}</option>
                          </select>
                          <div className="mt-1 text-[11px]">
                            {isLocal ? (
                              <span className="text-emerald-400">● {t('settings.chatProviderHintLocal')}</span>
                            ) : (
                              <span className="text-amber-400">● {t('settings.chatProviderHintCloud')}</span>
                            )}
                          </div>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-xs text-gray-500 mb-1">{t('settings.chatUrl')}</label>
                          <input
                            type="text"
                            value={endpoint.url}
                            onChange={(e) => updateChatEndpoint(idx, { url: e.target.value })}
                            placeholder={CHAT_PROVIDER_DEFAULT_URL[endpoint.provider]}
                            className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('settings.chatModel')}</label>
                          <input
                            type="text"
                            value={endpoint.model}
                            onChange={(e) => updateChatEndpoint(idx, { model: e.target.value })}
                            placeholder={CHAT_PROVIDER_DEFAULT_MODEL[endpoint.provider]}
                            className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                        </div>
                      </div>

                      {keySupported && (
                        <div className="mb-2">
                          <label className="block text-xs text-gray-500 mb-1">
                            {t('settings.chatApiKey')}
                            {keyRequired && <span className="text-red-400 ml-1">*</span>}
                          </label>
                          <div className="flex gap-2">
                            <input
                              type={keyVisible ? 'text' : 'password'}
                              value={endpoint.apiKey ?? ''}
                              onChange={(e) => updateChatEndpoint(idx, { apiKey: e.target.value })}
                              placeholder={
                                hasStoredKey && endpoint.apiKey === undefined
                                  ? t('settings.chatApiKeyPlaceholderStored')
                                  : endpoint.provider === 'anthropic'
                                    ? 'sk-ant-...'
                                    : 'sk-...'
                              }
                              autoComplete="off"
                              className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
                            />
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setChatApiKeyVisible((prev) => ({ ...prev, [idx]: !prev[idx] }))}
                            >
                              {keyVisible ? t('settings.chatApiKeyHide') : t('settings.chatApiKeyShow')}
                            </Button>
                            {hasStoredKey && (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => updateChatEndpoint(idx, { apiKey: '' })}
                              >
                                {t('settings.chatApiKeyClear')}
                              </Button>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="mb-2 flex items-center gap-2">
                        <label className="inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={!!endpoint.visionCapable}
                            onChange={(e) => updateChatEndpoint(idx, { visionCapable: e.target.checked })}
                            className="w-3.5 h-3.5 accent-violet-600"
                          />
                          {t('settings.chatVisionCapable')}
                        </label>
                        <span className="text-[11px] text-gray-500">{t('settings.chatVisionCapableHint')}</span>
                      </div>

                      {chatConfig.toolsEnabled && !toolsSupported && (
                        <div className="mb-2 text-[11px] text-amber-300/80 bg-amber-900/10 border border-amber-800/30 rounded px-2 py-1">
                          ⓘ {t('settings.chatToolsSkippedForProvider')}
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs flex-1">
                          {result?.ok && (
                            <span className="text-green-400">
                              ✓ {t('settings.chatTestOk')}
                              {result.models && result.models.length > 0 && (
                                <span className="text-gray-500"> · {result.models.length} Modelle</span>
                              )}
                            </span>
                          )}
                          {result && !result.ok && (
                            <span className="text-red-400">{t('settings.chatTestFail', { error: result.error })}</span>
                          )}
                        </div>
                        <Button size="sm" onClick={() => testChatEndpoint(idx)}>{t('settings.chatTestEndpoint')}</Button>
                        <Button variant="danger" size="sm" onClick={() => removeChatEndpoint(idx)}>{t('settings.chatRemoveEndpoint')}</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsSection>

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
            <Button variant="primary" size="lg" onClick={saveChatConfig} disabled={chatSaving}>
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
