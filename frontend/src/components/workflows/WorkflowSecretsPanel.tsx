import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, X } from 'lucide-react';
import type { WorkflowSecretInfo } from '../../api/workflows';
import { errorMessage } from '../../lib/narrow';
import { useToast } from '../Toast';

interface Props {
  secrets: WorkflowSecretInfo[];
  loading: boolean;
  error: string | null;
  /** Wohin die Secret-Verwaltung führt; ohne Projekt/Kunde (global) gibt es keinen Link. */
  manageHref: string | null;
  onClose: () => void;
}

/**
 * Für `{{secrets.KEY}}` erreichbare Secrets des Workflows — nur Schlüssel und
 * Beschreibung, nie Werte. Einfügen geschieht über TemplatePicker bzw.
 * Autovervollständigung im Feld; hier wird der Platzhalter nur kopiert.
 */
export function WorkflowSecretsPanel({ secrets, loading, error, manageHref, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();

  const copy = (key: string) => {
    navigator.clipboard.writeText(`{{secrets.${key}}}`)
      .then(() => toast.showSuccess(t('workflows.secrets.copied')))
      .catch((err: unknown) => toast.showError(errorMessage(err)));
  };

  const manageLink = manageHref !== null && (
    <Link to={manageHref} className="text-cyan-400 hover:text-cyan-300 underline">{t('workflows.secrets.manage')}</Link>
  );

  return (
    <div className="absolute right-0 top-full z-30 mt-1 w-96 max-w-[90vw] rounded-lg border border-gray-700 bg-gray-950 p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{t('workflows.secrets.title')}</h3>
        <button type="button" onClick={onClose} title={t('common.close')} className="rounded-sm p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200">
          <X size={14} />
        </button>
      </div>
      <p className="mb-2 text-[11px] text-gray-500">{t('workflows.secrets.hint')}</p>
      {loading && <p className="text-xs text-gray-500">{t('common.loading')}</p>}
      {error !== null && <p className="text-xs text-red-400">{error}</p>}
      {!loading && error === null && secrets.length === 0 && (
        <p className="text-xs text-gray-500">
          {t('workflows.secrets.empty')} {manageLink}
        </p>
      )}
      {secrets.length > 0 && (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {secrets.map((s) => (
            <li key={`${s.origin}:${s.key}`} className="flex items-start justify-between gap-2 rounded-sm bg-gray-900 px-2 py-1.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <code className="truncate text-xs text-cyan-300">{s.key}</code>
                  <span className="rounded-sm bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                    {t(`workflows.secrets.origin.${s.origin}`)}
                  </span>
                </div>
                {s.description && <p className="mt-0.5 text-[11px] text-gray-500">{s.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => copy(s.key)}
                title={t('workflows.secrets.copy')}
                className="shrink-0 rounded-sm p-1 text-gray-400 hover:bg-gray-800 hover:text-cyan-300"
              >
                <Copy size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {secrets.length > 0 && manageHref !== null && <p className="mt-2 text-[11px]">{manageLink}</p>}
    </div>
  );
}
