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
import RagSettings from '../components/settings/RagSettings';
import ChatLogSettings from '../components/settings/ChatLogSettings';
import InstructionsSettings from '../components/settings/InstructionsSettings';
import ApiKeysSettings from '../components/settings/ApiKeysSettings';
import ChatLlmSettings from '../components/settings/ChatLlmSettings';
import MyLlmSettings from '../components/settings/MyLlmSettings';
import WorkflowAgentSettings from '../components/settings/WorkflowAgentSettings';
import OnboardingBanner from '../components/settings/OnboardingBanner';
import { SettingsShell } from '../components/ui/SettingsShell';

type SettingsTab = 'instructions' | 'apikeys' | 'notifications' | 'myllm' | 'chat' | 'chatlog' | 'rag' | 'websearch' | 'users' | 'auditlog' | 'replication' | 'backups' | 'customerTemplates' | 'workflowAgent';

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
    { key: 'chat', label: t('settings.tabChat'), group: t('settings.groupAgentStack'), adminOnly: true },
    { key: 'workflowAgent', label: t('settings.tabWorkflowAgent'), group: t('settings.groupAgentStack'), adminOnly: true },
    { key: 'rag', label: t('settings.tabRag'), group: t('settings.groupAgentStack'), adminOnly: true },
    { key: 'websearch', label: t('settings.tabWebSearch'), group: t('settings.groupAgentStack'), adminOnly: true },

    { key: 'apikeys', label: t('settings.tabApiKeys'), group: t('settings.groupAccess') },
    { key: 'users', label: t('settings.tabUsers'), group: t('settings.groupAccess'), adminOnly: true },

    { key: 'backups', label: t('settings.tabBackups'), group: t('settings.groupInfra'), adminOnly: true },
    { key: 'replication', label: t('settings.tabReplication'), group: t('settings.groupInfra'), adminOnly: true },
    { key: 'customerTemplates', label: t('settings.tabCustomerTemplates'), group: t('settings.groupInfra'), adminOnly: true },

    { key: 'notifications', label: t('settings.tabNotifications'), group: t('settings.groupObserve') },
    { key: 'auditlog', label: t('settings.tabAuditLog'), group: t('settings.groupObserve'), adminOnly: true },
    { key: 'chatlog', label: t('settings.tabChatLog'), group: t('settings.groupObserve'), adminOnly: true },
  ];

  const visibleTabs = tabs.filter((tb) => !tb.adminOnly || isAdmin);

  return (
    <SettingsShell title={t('settings.title')} tabs={visibleTabs} activeTab={tab} onTabChange={setTab}>
      {isAdmin && <OnboardingBanner onJumpTo={(t) => setTab(t as SettingsTab)} />}
      {tab === 'instructions' && <InstructionsSettings />}
      {tab === 'apikeys' && <ApiKeysSettings />}
      {tab === 'notifications' && <NotificationsSettings />}
      {tab === 'chat' && isAdmin && <ChatLlmSettings />}
      {tab === 'myllm' && <MyLlmSettings />}
      {tab === 'workflowAgent' && isAdmin && <WorkflowAgentSettings />}
      {tab === 'users' && isAdmin && <UserManagement />}
      {tab === 'auditlog' && isAdmin && <AuditLog />}
      {tab === 'rag' && isAdmin && <RagSettings />}
      {tab === 'chatlog' && isAdmin && <ChatLogSettings />}
      {tab === 'websearch' && isAdmin && <WebSearchSettings />}
      {tab === 'backups' && isAdmin && <BackupSettings />}
      {tab === 'customerTemplates' && isAdmin && <CustomerTemplatesSettings />}
      {tab === 'replication' && isAdmin && <ReplicationSettings />}
    </SettingsShell>
  );
}
