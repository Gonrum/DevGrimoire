import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/Dialog';
import Button from '../ui/Button';
import { FormTextarea } from '../ui/FormField';

export default function DeepenDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (question: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const q = question.trim();
  return (
    <Dialog title={t('researchRun.deepen.title')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.length < 3) return;
          setBusy(true);
          void onSubmit(q).finally(() => setBusy(false));
        }}
      >
        <FormTextarea
          label={t('researchRun.deepen.question')}
          required
          rows={3}
          maxLength={500}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t('researchRun.deepen.placeholder')}
          autoFocus
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="md" disabled={busy || q.length < 3}>{t('researchRun.deepen.submit')}</Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
