import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { errorMessage } from '../../lib/narrow';
import { validateResearchFiles, type ResearchDepth } from '../../lib/research';
import { Dialog } from '../ui/Dialog';
import Button from '../ui/Button';
import { FormSelect, FormTextarea } from '../ui/FormField';
import { useToast } from '../Toast';

const DEPTHS: ResearchDepth[] = ['quick', 'normal', 'thorough'];

export default function NewResearchDialog({
  moveTargetHint,
  targetName,
  onClose,
  onStarted,
}: {
  moveTargetHint?: string;
  targetName?: string;
  onClose: () => void;
  onStarted: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { showSuccess } = useToast();
  const [topicsText, setTopicsText] = useState('');
  const [focus, setFocus] = useState('');
  const [depth, setDepth] = useState<ResearchDepth>('normal');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const topics = topicsText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const validate = (): string | null => {
    if (topics.length < 1 || topics.length > 20) return t('researchRun.errors.topicCount');
    if (topics.some((x) => x.length < 3 || x.length > 300)) return t('researchRun.errors.topicLength');
    const fileError = validateResearchFiles(files.map((f) => ({ name: f.name, size: f.size })));
    return fileError ? t(fileError) : null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const { ids } = await api.research.start({
        topics,
        focus: focus.trim() || undefined,
        depth,
        files,
        moveTargetHint,
      });
      showSuccess(t('researchRun.form.started', { count: ids.length }));
      onStarted(ids);
    } catch (err) {
      // Eingaben bleiben stehen: der Nutzer korrigiert und sendet erneut.
      setError(errorMessage(err, t('common.errorSaving')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('researchRun.new')} onClose={onClose}>
      <form onSubmit={(e) => { void submit(e); }} className="space-y-4">
        <FormTextarea
          label={t('researchRun.form.topics')}
          required
          rows={3}
          value={topicsText}
          onChange={(e) => setTopicsText(e.target.value)}
          placeholder={t('researchRun.form.topicsPlaceholder')}
          helpText={t('researchRun.form.topicsHelp')}
          autoFocus
        />
        <FormTextarea
          label={t('researchRun.form.focus')}
          rows={2}
          maxLength={500}
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder={t('researchRun.form.focusPlaceholder')}
        />
        <FormSelect
          label={t('researchRun.depth.label')}
          value={depth}
          onChange={(e) => {
            const next = DEPTHS.find((d) => d === e.target.value);
            if (next) setDepth(next);
          }}
        >
          {DEPTHS.map((d) => <option key={d} value={d}>{t(`researchRun.depth.${d}`)}</option>)}
        </FormSelect>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('researchRun.form.files')}</label>
          <input
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.log,.ini,.toml,.sql,.js,.ts,.tsx,.jsx,.py,.java,.cs,.go,.rs,.php,.rb,.sh,.pdf,text/*,application/pdf"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-sm text-gray-400 file:mr-3 file:rounded-sm file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-gray-300"
          />
          <p className="text-xs text-gray-600 mt-1">{t('researchRun.form.filesHelp')}</p>
        </div>
        {moveTargetHint && targetName && (
          <p className="text-xs text-violet-300">{t('researchRun.form.target', { name: targetName })}</p>
        )}
        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="md" disabled={busy}>
            {busy ? t('researchRun.form.starting') : t('researchRun.form.start')}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
