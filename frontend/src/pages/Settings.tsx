import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import UserManagement from './UserManagement';
import AuditLog from './AuditLog';
import ReplicationSettings from '../components/ReplicationSettings';
import WebSearchSettings from '../components/WebSearchSettings';
import NotificationsSettings from '../components/settings/NotificationsSettings';
import BackupSettings from '../components/settings/BackupSettings';
import CustomerTemplatesSettings from '../components/settings/CustomerTemplatesSettings';
import ChatLogSettings from '../components/settings/ChatLogSettings';
import InstructionsSettings from '../components/settings/InstructionsSettings';
import ApiKeysSettings from '../components/settings/ApiKeysSettings';
import MyLlmSettings from '../components/settings/MyLlmSettings';
import LlmEndpointsSettings from '../components/settings/LlmEndpointsSettings';
import OnboardingBanner from '../components/settings/OnboardingBanner';
import SshSettings from '../components/settings/SshSettings';
import { SettingsShell } from '../components/ui/SettingsShell';
import { matchOption } from '../lib/narrow';

/**
 * Die Tab-Schlüssel als Laufzeit-Liste, nicht nur als Typ: `OnboardingBanner`
 * liefert `onJumpTo(tab: string)`, und ein `as SettingsTab` darauf wäre eine
 * Behauptung. Mit der Liste lässt sich der Wert prüfen (`matchOption`), womit
 * ein umbenannter Tab-Key nicht mehr in einen State läuft, den kein Zweig
 * rendert (leere Settings-Seite), sondern still ignoriert wird.
 */
const SETTINGS_TABS = [
  'instructions', 'apikeys', 'notifications', 'myllm', 'llmEndpoints', 'chatlog',
  'websearch', 'users', 'auditlog', 'replication', 'backups', 'customerTemplates', 'ssh',
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

export default function Settings() {
  const { t } = useTranslation();
  const { user, authEnabled } = useAuth();
  const isAdmin = authEnabled && user?.role === 'admin';
  const [tab, setTab] = useState<SettingsTab>('instructions');

  // T-328: four IA buckets instead of three. Agent-stack groups everything
  // that shapes how/what the agent thinks (LLMs, RAG, web-search, prompts,
  // workflow agent). Access groups auth surfaces. Infra groups data
  // movement & templating. Observe groups notification + log surfaces.
  const tabs: { key: SettingsTab; label: string; group?: string; adminOnly?: boolean }[] = [
    { key: 'instructions', label: t('settings.tabInstructions'), group: t('settings.groupAgentStack') },
    { key: 'myllm', label: t('settings.tabMyLlm'), group: t('settings.groupAgentStack') },
    { key: 'llmEndpoints', label: t('settings.tabLlmEndpoints'), group: t('settings.groupAgentStack'), adminOnly: true },
    { key: 'websearch', label: t('settings.tabWebSearch'), group: t('settings.groupAgentStack'), adminOnly: true },

    { key: 'apikeys', label: t('settings.tabApiKeys'), group: t('settings.groupAccess') },
    { key: 'users', label: t('settings.tabUsers'), group: t('settings.groupAccess'), adminOnly: true },

    { key: 'backups', label: t('settings.tabBackups'), group: t('settings.groupInfra'), adminOnly: true },
    { key: 'replication', label: t('settings.tabReplication'), group: t('settings.groupInfra'), adminOnly: true },
    { key: 'ssh', label: t('settings.tabSsh'), group: t('settings.groupInfra'), adminOnly: true },
    { key: 'customerTemplates', label: t('settings.tabCustomerTemplates'), group: t('settings.groupInfra'), adminOnly: true },

    { key: 'notifications', label: t('settings.tabNotifications'), group: t('settings.groupObserve') },
    { key: 'auditlog', label: t('settings.tabAuditLog'), group: t('settings.groupObserve'), adminOnly: true },
    { key: 'chatlog', label: t('settings.tabChatLog'), group: t('settings.groupObserve'), adminOnly: true },
  ];

  const visibleTabs = tabs.filter((tb) => !tb.adminOnly || isAdmin);

  return (
    <SettingsShell title={t('settings.title')} tabs={visibleTabs} activeTab={tab} onTabChange={setTab}>
      {isAdmin && (
        <OnboardingBanner
          onJumpTo={(key) => {
            const next = matchOption(key, SETTINGS_TABS);
            if (next) setTab(next);
          }}
        />
      )}
      {tab === 'instructions' && <InstructionsSettings />}
      {tab === 'apikeys' && <ApiKeysSettings />}
      {tab === 'notifications' && <NotificationsSettings />}
      {tab === 'myllm' && <MyLlmSettings />}
      {tab === 'llmEndpoints' && isAdmin && <LlmEndpointsSettings />}
      {tab === 'users' && isAdmin && <UserManagement />}
      {tab === 'auditlog' && isAdmin && <AuditLog />}
      {tab === 'chatlog' && isAdmin && <ChatLogSettings />}
      {tab === 'websearch' && isAdmin && <WebSearchSettings />}
      {tab === 'backups' && isAdmin && <BackupSettings />}
      {tab === 'customerTemplates' && isAdmin && <CustomerTemplatesSettings />}
      {tab === 'replication' && isAdmin && <ReplicationSettings />}
      {tab === 'ssh' && isAdmin && <SshSettings />}
    </SettingsShell>
  );
}
