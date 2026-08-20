import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ParsedKubeContext } from '../../api/client';
import { errorMessage } from '../../lib/narrow';
import Button from '../ui/Button';
import { FormInput, FormSelect, FormTextarea } from '../ui/FormField';

export interface KubeClusterFormScope {
  projectId?: string;
  customerId?: string;
}

export interface KubeClusterFormProps {
  scope: KubeClusterFormScope;
  onCreated: () => void;
  onCancel: () => void;
}

/**
 * Zweistufiger Fluss: Kubeconfig einfügen → Contexts vom Server parsen lassen
 * → einen auswählen. Der Kubeconfig-Rohtext bleibt bis zum `POST /kube-clusters`
 * im Formular-State und wird nie an eine andere Stelle geloggt oder angezeigt —
 * der Server echot ihn ebenfalls nicht zurück (400 bei einem defekten Parse ist
 * generisch, siehe `api.parseKubeconfig`).
 */
export function KubeClusterForm({ scope, onCreated, onCancel }: KubeClusterFormProps) {
  const { t } = useTranslation();
  const [kubeconfig, setKubeconfig] = useState('');
  const [contexts, setContexts] = useState<ParsedKubeContext[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const [transport, setTransport] = useState<'direct' | 'ssh-tunnel'>('direct');
  const [sshConnectionId, setSshConnectionId] = useState('');
  const [allowInsecureTls, setAllowInsecureTls] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = contexts?.find((c) => c.contextName === selected) ?? null;
  const needsInsecureAck =
    chosen !== null &&
    (chosen.warnings.includes('insecure_tls') || chosen.warnings.includes('no_ca'));
  const canSubmit =
    chosen !== null &&
    chosen.rejections.length === 0 &&
    label.trim().length > 0 &&
    slug.trim().length >= 3 &&
    (!needsInsecureAck || allowInsecureTls) &&
    (transport === 'direct' || sshConnectionId.length > 0);

  async function loadContexts() {
    setBusy(true);
    setError(null);
    try {
      const parsed = await api.parseKubeconfig(kubeconfig);
      setContexts(parsed.contexts);
      setSelected(parsed.currentContext ?? parsed.contexts[0]?.contextName ?? null);
    } catch (err) {
      setError(errorMessage(err, t('kube.form.loadContextsFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await api.createKubeCluster({
        label,
        slug,
        projectId: scope.projectId,
        customerId: scope.customerId,
        kubeconfig,
        contextName: chosen.contextName,
        transport,
        sshConnectionId: transport === 'ssh-tunnel' ? sshConnectionId : undefined,
        allowInsecureTls,
      });
      onCreated();
    } catch (err) {
      // Server gibt für 400 (Invariante verletzt) und 409 (Slug vergeben)
      // jeweils eine lesbare `message` zurück — die landet hier unverändert,
      // damit "Slug vergeben" nicht als generischer Fehler erscheint.
      setError(errorMessage(err, t('kube.form.submitFailed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <FormTextarea
        label={t('kube.form.kubeconfigLabel')}
        className="h-40 font-mono text-xs"
        value={kubeconfig}
        onChange={(e) => setKubeconfig(e.target.value)}
        placeholder={t('kube.form.kubeconfigPlaceholder')}
      />
      <input
        type="file"
        accept=".yaml,.yml,.conf,.config,text/plain"
        className="block text-sm text-gray-400"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          void file.text().then(setKubeconfig);
        }}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy || kubeconfig.trim().length === 0}
        onClick={() => void loadContexts()}
      >
        {t('kube.form.loadContexts')}
      </Button>

      {contexts !== null && (
        <fieldset className="space-y-2">
          <legend className="text-sm text-gray-300">{t('kube.form.chooseContext')}</legend>
          {contexts.map((ctx) => {
            const blocked = ctx.rejections.length > 0;
            return (
              <label
                key={ctx.contextName}
                className="flex items-start gap-2 rounded border border-gray-700 p-2"
              >
                <input
                  type="radio"
                  name="kube-context"
                  className="mt-1"
                  disabled={blocked}
                  checked={selected === ctx.contextName}
                  onChange={() => setSelected(ctx.contextName)}
                />
                <span>
                  <span className="font-medium text-gray-200">{ctx.contextName}</span>
                  <span className="block text-xs text-gray-500">{ctx.server}</span>
                  {ctx.warnings.map((warning) => (
                    <span key={warning} className="block text-xs text-amber-400">
                      {t(`kube.form.warning.${warning}`)}
                    </span>
                  ))}
                  {ctx.rejections.map((rejection) => (
                    <span key={rejection} className="block text-xs text-red-400">
                      {t(`kube.form.rejection.${rejection}`)}
                    </span>
                  ))}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {needsInsecureAck && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input
            type="checkbox"
            checked={allowInsecureTls}
            onChange={(e) => setAllowInsecureTls(e.target.checked)}
          />
          {t('kube.form.insecureAck')}
        </label>
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormInput
          label={t('kube.form.label')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <FormInput
          label={t('kube.form.slug')}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={t('kube.form.slugPlaceholder')}
        />
      </div>

      <FormSelect
        label={t('kube.form.transport')}
        value={transport}
        onChange={(e) => setTransport(e.target.value === 'ssh-tunnel' ? 'ssh-tunnel' : 'direct')}
      >
        <option value="direct">{t('kube.form.transportDirect')}</option>
        <option value="ssh-tunnel">{t('kube.form.transportTunnel')}</option>
      </FormSelect>

      {transport === 'ssh-tunnel' && (
        <FormInput
          label={t('kube.form.sshConnectionId')}
          value={sshConnectionId}
          onChange={(e) => setSshConnectionId(e.target.value)}
          placeholder={t('kube.form.sshConnectionPlaceholder')}
        />
      )}

      {error !== null && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="success"
          size="sm"
          disabled={!canSubmit || busy}
          onClick={() => void submit()}
        >
          {t('kube.form.submit')}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          {t('kube.form.cancel')}
        </Button>
      </div>
    </div>
  );
}
