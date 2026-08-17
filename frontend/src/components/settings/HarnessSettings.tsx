import { useTranslation } from 'react-i18next';
import HarnessView from '../HarnessView';

/**
 * Der globale Harness (T-444, M-51/H1).
 *
 * Kein `resolveProjectId`: eine Auflösung gibt es nur aus Sicht eines
 * Projekts. Was hier steht, ist die oberste Ebene — sie wird von jeder
 * Kunden- und Projektebene geerbt und dort ergänzt oder überschrieben.
 */
export default function HarnessSettings() {
  const { t } = useTranslation();

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-medium text-gray-200">{t('settings.harnessTitle')}</h2>
        <p className="text-sm text-gray-500 mt-1">{t('settings.harnessHint')}</p>
      </div>
      <HarnessView owner={{ scope: 'global' }} />
    </div>
  );
}
