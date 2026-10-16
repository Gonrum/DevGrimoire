import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { parseMoveTarget } from '../../lib/research';
import { Dialog } from '../ui/Dialog';
import Button from '../ui/Button';
import { FormSelect } from '../ui/FormField';

type Kind = 'project' | 'customer';
interface Option { id: string; name: string }

export default function MoveResearchDialog({
  hint,
  onClose,
  onSubmit,
}: {
  hint?: string;
  onClose: () => void;
  onSubmit: (target: { projectId: string } | { customerId: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const suggested = parseMoveTarget(hint);
  const [kind, setKind] = useState<Kind>(suggested?.kind ?? 'project');
  const [targetId, setTargetId] = useState(suggested?.id ?? '');
  const [projects, setProjects] = useState<Option[]>([]);
  const [customers, setCustomers] = useState<Option[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.projects.list(), api.customers.list()]).then(([p, c]) => {
      if (!alive) return;
      setProjects(p.map((x) => ({ id: x._id, name: x.name })));
      setCustomers(c.map((x) => ({ id: x._id, name: x.name })));
    }).catch(() => { /* leere Auswahl; Fehler zeigt der Submit */ });
    return () => { alive = false; };
  }, []);

  const options = kind === 'project' ? projects : customers;

  return (
    <Dialog title={t('researchRun.move.title')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!targetId) return;
          setBusy(true);
          const target = kind === 'project' ? { projectId: targetId } : { customerId: targetId };
          void onSubmit(target).finally(() => setBusy(false));
        }}
      >
        <FormSelect
          label={t('researchRun.move.kind')}
          value={kind}
          onChange={(e) => { setKind(e.target.value === 'customer' ? 'customer' : 'project'); setTargetId(''); }}
        >
          <option value="project">{t('researchRun.move.project')}</option>
          <option value="customer">{t('researchRun.move.customer')}</option>
        </FormSelect>
        <FormSelect
          label={kind === 'project' ? t('researchRun.move.project') : t('researchRun.move.customer')}
          required
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          <option value="">{t('researchRun.move.choose')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}{suggested && suggested.kind === kind && suggested.id === o.id ? ` (${t('researchRun.move.suggested')})` : ''}
            </option>
          ))}
        </FormSelect>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="md" disabled={busy || !targetId}>{t('researchRun.move.submit')}</Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
