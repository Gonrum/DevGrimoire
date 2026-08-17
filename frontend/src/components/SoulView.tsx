import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Soul } from '../api/client';
import { errorMessage } from '../lib/narrow';
import Markdown from '../components/Markdown';
import MarkdownEditor from '../components/MarkdownEditor';
import Button from '../components/ui/Button';

const SECTIONS = [
  { key: 'vision', icon: '\u{1F3AF}' },
  { key: 'principles', icon: '\u{1F3D7}\uFE0F' },
  { key: 'conventions', icon: '\u{1F4DD}' },
  { key: 'communication', icon: '\u{1F4AC}' },
  { key: 'boundaries', icon: '\u{1F6E1}\uFE0F' },
  { key: 'workflow', icon: '\u2699\uFE0F' },
  { key: 'quality', icon: '\u2705' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

interface Props {
  projectId?: string;
  customerId?: string;
  soul: Soul | null;
  onUpdate: () => void;
}

export default function SoulView({ projectId, customerId, soul, onUpdate }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<SectionKey | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const definedCount = SECTIONS.filter((s) => soul?.[s.key]?.trim()).length;

  const handleEdit = (key: SectionKey) => {
    setEditing(key);
    setDraft(soul?.[key] || '');
    setError(null);
  };

  /**
   * `catch` statt nur `finally`: vorher blieb ein fehlgeschlagenes `upsert`
   * unsichtbar — der Editor blieb offen, der Text stand noch da, und der Nutzer
   * hatte keinen Hinweis, dass nichts gespeichert wurde.
   */
  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api.souls.upsert({ projectId, customerId, [editing]: draft });
      onUpdate();
      setEditing(null);
      setDraft('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditing(null);
    setDraft('');
    setError(null);
  };

  const allEmpty = definedCount === 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-gray-500">
          {t('soul.sectionsComplete', { count: definedCount })}
        </div>
      </div>

      {allEmpty && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6 text-center">
          <p className="text-gray-400 mb-2">{t('soul.empty')}</p>
          <p className="text-gray-500 text-sm">{t('soul.emptyHint')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {SECTIONS.map((section) => {
          const content = soul?.[section.key] || '';
          const isEditing = editing === section.key;

          return (
            <div
              key={section.key}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-300">
                  <span className="mr-1.5">{section.icon}</span>
                  {t(`soul.${section.key}`)}
                </h3>
                {!isEditing && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => handleEdit(section.key)}
                  >
                    {t('common.edit')}
                  </Button>
                )}
              </div>

              {isEditing ? (
                <div>
                  <MarkdownEditor
                    value={draft}
                    onChange={setDraft}
                    rows={6}
                    placeholder={t(`soul.${section.key}Placeholder`)}
                  />
                  {error && (
                    <div className="mt-2 bg-red-900/20 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
                      {error}
                    </div>
                  )}
                  <div className="flex gap-2 mt-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        void handleSave();
                      }}
                      disabled={saving}
                    >
                      {saving ? t('common.saving') : t('common.save')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleCancel}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : content.trim() ? (
                <Markdown>{content}</Markdown>
              ) : (
                <p className="text-sm text-gray-600 italic">
                  {t('soul.sectionEmpty')}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
