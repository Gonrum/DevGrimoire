import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Milestone, Todo } from '../api/client';
import MarkdownEditor from './MarkdownEditor';
import Button from './ui/Button';
import { DictationButton } from './ui/DictationButton';
import { FormInput, FormSelect } from './ui/FormField';
import { SpeechConsentDialog } from './ui/SpeechConsentDialog';

interface TodoFormProps {
  /** Project context — set this OR customerId, not both. */
  projectId?: string;
  /** Customer context — set this OR projectId, not both. Disables milestone select and attachments. */
  customerId?: string;
  initialMilestoneId?: string;
  milestones?: Milestone[];
  showMilestoneSelect?: boolean;
  allowMilestoneCreate?: boolean;
  enableDictation?: boolean;
  descriptionRows?: number;
  submitSize?: 'md' | 'lg';
  className?: string;
  onCreated: (todo: Todo) => void;
  onCancel: () => void;
  onMilestoneCreated?: (milestone: Milestone) => void;
}

export default function TodoForm({
  projectId,
  customerId,
  initialMilestoneId = '',
  milestones = [],
  showMilestoneSelect = false,
  allowMilestoneCreate = false,
  enableDictation = false,
  descriptionRows = 5,
  submitSize = 'lg',
  className = '',
  onCreated,
  onCancel,
  onMilestoneCreated,
}: TodoFormProps) {
  const isCustomerScope = !projectId && !!customerId;
  const effectiveShowMilestone = showMilestoneSelect && !isCustomerScope;
  const effectiveAllowMilestoneCreate = allowMilestoneCreate && !isCustomerScope;
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('medium');
  const [tags, setTags] = useState('');
  const [milestoneId, setMilestoneId] = useState(initialMilestoneId);
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [creatingMilestone, setCreatingMilestone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [speechConsent, setSpeechConsent] = useState(localStorage.getItem('speech_consent') === 'true');
  const [showConsentDialog, setShowConsentDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shouldShowDictation = enableDictation && speechConsent;

  useEffect(() => { setMilestoneId(initialMilestoneId); }, [initialMilestoneId]);
  useEffect(() => {
    if (isCustomerScope) { setStorageEnabled(false); return; }
    api.attachments.storageStatus().then((s) => setStorageEnabled(s.enabled)).catch(() => {});
  }, [isCustomerScope]);
  useEffect(() => {
    if (enableDictation && !speechConsent) setShowConsentDialog(true);
  }, [enableDictation, speechConsent]);

  const handleCreateMilestone = async () => {
    if (!effectiveAllowMilestoneCreate || !projectId || !newMilestoneName.trim()) return;
    const milestone = await api.milestones.create({ projectId, name: newMilestoneName.trim() });
    setNewMilestoneName('');
    setCreatingMilestone(false);
    setMilestoneId(milestone._id);
    onMilestoneCreated?.(milestone);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const todo = await api.todos.create({
        projectId,
        customerId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        status: 'open',
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        milestoneId: milestoneId || undefined,
      } as Partial<Todo> & { milestoneId?: string });

      if (projectId && pendingFiles.length > 0 && todo._id) {
        for (const file of pendingFiles) {
          await api.attachments.upload(projectId, file, { entityType: 'todo', entityId: todo._id }).catch(() => {});
        }
      }

      onCreated(todo);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit} className={`space-y-4 ${className}`}>
        <div className="flex flex-col sm:flex-row sm:items-end gap-2">
          <FormInput fieldClassName="flex-1 min-w-0 w-full" label={t('common.title')} required type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('common.title')} autoFocus />
          {shouldShowDictation && (
            <DictationButton onTextUpdate={(text, isFinal) => {
              setTitle((prev) => isFinal ? prev + ' ' + text : text);
            }} />
          )}
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
          <div className="flex flex-col sm:flex-row sm:items-start gap-2">
            <div className="flex-1 min-w-0 w-full">
              <MarkdownEditor value={description} onChange={setDescription} rows={descriptionRows} placeholder={t('todoCreate.descriptionPlaceholder')} />
            </div>
            {shouldShowDictation && (
              <DictationButton onTextUpdate={(text, isFinal) => {
                setDescription((prev) => isFinal ? prev + ' ' + text : text);
              }} />
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <FormSelect fieldClassName="w-full sm:w-44 shrink-0" label={t('common.priority')} value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}>
            <option value="low">{t('todoPriority.low')}</option>
            <option value="medium">{t('todoPriority.medium')}</option>
            <option value="high">{t('todoPriority.high')}</option>
            <option value="critical">{t('todoPriority.critical')}</option>
          </FormSelect>
          <FormInput fieldClassName="flex-1 min-w-0 w-full" label={t('common.tags')} type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('todoCreate.tagsPlaceholder')} />
        </div>

        {effectiveShowMilestone && (
          <div className="space-y-2">
            <FormSelect fieldClassName="w-full" label={t('todoCreate.milestone')} value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
              <option value="">{t('todoCreate.noMilestone')}</option>
              {milestones.map((ms) => (
                <option key={ms._id} value={ms._id}>{ms.name}</option>
              ))}
            </FormSelect>
            {effectiveAllowMilestoneCreate && (creatingMilestone ? (
              <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                <FormInput fieldClassName="flex-1 min-w-0 w-full" type="text" value={newMilestoneName} onChange={(e) => setNewMilestoneName(e.target.value)}
                  placeholder={t('common.name')} autoFocus onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleCreateMilestone())} />
                <Button type="button" variant="primary" size="sm" disabled={!newMilestoneName.trim()} onClick={handleCreateMilestone}>
                  {t('common.create')}
                </Button>
                <Button type="button" size="sm" onClick={() => { setCreatingMilestone(false); setNewMilestoneName(''); }}>
                  {t('common.cancel')}
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" className="w-full sm:w-auto" onClick={() => setCreatingMilestone(true)}>
                {t('todoCreate.newMilestone')}
              </Button>
            ))}
          </div>
        )}

        {storageEnabled && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('attachments.attachments')}</label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border-2 border-dashed border-gray-700 hover:border-gray-600 bg-gray-900/50 px-4 py-4 text-center cursor-pointer transition-colors"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  if (e.target.files) {
                    setPendingFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />
              {pendingFiles.length === 0 ? (
                <p className="text-sm text-gray-500">{t('attachments.dropzone')}</p>
              ) : (
                <div className="space-y-1">
                  {pendingFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-sm text-gray-300">
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setPendingFiles((prev) => prev.filter((_, j) => j !== i)); }}
                        className="text-red-400 hover:text-red-300 ml-2 text-xs"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                  <p className="text-xs text-gray-600 mt-1">{t('attachments.dropzone')}</p>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size={submitSize} disabled={saving || !title.trim()}>
            {saving ? t('common.creating') : t('common.create')}
          </Button>
          <Button type="button" size={submitSize} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>

      {enableDictation && (
        <SpeechConsentDialog
          isOpen={showConsentDialog}
          onClose={() => setShowConsentDialog(false)}
          onConsent={() => {
            setSpeechConsent(true);
            localStorage.setItem('speech_consent', 'true');
            setShowConsentDialog(false);
          }}
        />
      )}
    </>
  );
}
