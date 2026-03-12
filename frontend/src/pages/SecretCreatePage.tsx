import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Environment, SecretType } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormSelect } from '../components/ui/FormField';

export default function SecretCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showError } = useToast();
  const { t } = useTranslation();

  const SECRET_TYPES: { value: SecretType; label: string; description: string; icon: string }[] = [
    { value: 'variable', label: t('secretCreate.typeVariable'), description: t('secretCreate.typeVariableDesc'), icon: '{ }' },
    { value: 'password', label: t('secretCreate.typePassword'), description: t('secretCreate.typePasswordDesc'), icon: '***' },
    { value: 'token', label: t('secretCreate.typeToken'), description: t('secretCreate.typeTokenDesc'), icon: 'key' },
    { value: 'ssh_key', label: t('secretCreate.typeSshKey'), description: t('secretCreate.typeSshKeyDesc'), icon: 'ssh' },
    { value: 'certificate', label: t('secretCreate.typeCertificate'), description: t('secretCreate.typeCertificateDesc'), icon: 'ssl' },
    { value: 'file', label: t('secretCreate.typeFile'), description: t('secretCreate.typeFileDesc'), icon: 'doc' },
  ];
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<SecretType>('variable');
  const [environmentId, setEnvironmentId] = useState(searchParams.get('environmentId') || '');
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (id) api.environments.list(id).then(setEnvironments).catch(() => {});
  }, [id]);

  const isMultiline = type === 'ssh_key' || type === 'certificate' || type === 'file';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !key.trim() || !value) return;
    setSaving(true);
    try {
      await api.secrets.create({
        projectId: id,
        key: key.trim(),
        value,
        description: description.trim() || undefined,
        type,
        environmentId: environmentId || undefined,
      });
      navigate(`/projects/${id}?tab=${environmentId ? 'environments' : 'secrets'}`);
    } catch (err: any) {
      showError(err.message || t('secretCreate.errorCreating'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}?tab=${environmentId ? 'environments' : 'secrets'}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; {t('secretCreate.backToProject')}</Link>

      <h1 className="text-xl font-bold mb-6">{t('secretCreate.title')}</h1>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-6">
        {/* Type selection */}
        <div>
          <label className="block text-xs text-gray-500 mb-2">{t('secretCreate.typeLabel')}</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {SECRET_TYPES.map((st) => (
              <button key={st.value} type="button" onClick={() => setType(st.value)}
                className={`text-left p-3 rounded-lg border transition-colors ${type === st.value
                  ? 'border-violet-500 bg-violet-900/20'
                  : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{st.icon}</span>
                  <span className={`text-sm font-medium ${type === st.value ? 'text-cyan-400' : 'text-gray-300'}`}>{st.label}</span>
                </div>
                <p className="text-xs text-gray-500">{st.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Key */}
        <FormInput label="Key" required type="text" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={type === 'ssh_key' ? t('secretCreate.keyPlaceholder_ssh_key') : type === 'token' ? t('secretCreate.keyPlaceholder_token') : type === 'password' ? t('secretCreate.keyPlaceholder_password') : t('secretCreate.keyPlaceholder_default')}
          className="font-mono" autoFocus />

        {/* Value */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('secretCreate.valueLabel')}</label>
          {isMultiline ? (
            <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={8}
              placeholder={type === 'ssh_key' ? t('secretCreate.valuePlaceholder_ssh_key') : type === 'certificate' ? t('secretCreate.valuePlaceholder_certificate') : t('secretCreate.valuePlaceholder_file')}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-y" />
          ) : (
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('secretCreate.valuePlaceholder')}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
          )}
        </div>

        {/* Description */}
        <FormInput label={t('common.description')} type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('secretCreate.descriptionPlaceholder')} />

        {/* Environment scope */}
        <div>
          <FormSelect label={t('secretCreate.environment')} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
            <option value="">{t('secretCreate.globalEnv')}</option>
            {environments.map((env) => (
              <option key={env._id} value={env._id}>{env.name}</option>
            ))}
          </FormSelect>
          <p className="text-xs text-gray-600 mt-1">{t('secretCreate.envHint')}</p>
        </div>

        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !key.trim() || !value}>
            {saving ? t('common.creating') : t('secretCreate.createSecret')}
          </Button>
          <Button type="button" size="lg" onClick={() => navigate(`/projects/${id}?tab=secrets`)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
