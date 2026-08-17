import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { errorMessage } from '../../lib/narrow';
import { useToast } from '../Toast';
import { Dialog, Portal } from '../ui/Dialog';
import { FormInput, FormTextarea } from '../ui/FormField';
import Button from '../ui/Button';

interface Props {
  onCancel: () => void;
  onCreated: (id: string) => void;
}

export default function CreateStackDialog({ onCancel, onCreated }: Props) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const stack = await api.stacks.create({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated(stack._id);
    } catch (err) {
      showError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Portal>
      <Dialog title={t('stacks.createTitle')} onClose={onCancel}>
        <div className="p-5 space-y-4">
          <FormInput label={t('stacks.name')} required value={name} onChange={(e) => setName(e.target.value)} />
          <FormTextarea label={t('stacks.description')} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void handleCreate()} disabled={saving || !name.trim()}>
              {saving ? t('common.creating') : t('stacks.createAction')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Portal>
  );
}
