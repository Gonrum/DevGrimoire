import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, UserInfo } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { LoadingText } from '../components/ui/LoadingSpinner';

export default function Profile() {
  const { t, i18n } = useTranslation();
  const [profile, setProfile] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPw, setChangingPw] = useState(false);

  const { showError, showSuccess } = useToast();

  const loadProfile = async () => {
    try {
      const data = await api.profile.get();
      setProfile(data);
      setUsername(data.username);
      setEmail(data.email || '');
    } catch (err: any) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.profile.update({
        username: username.trim(),
        email: email.trim() || undefined,
      });
      setProfile(updated);
      showSuccess(t('profile.profileUpdated'));
    } catch (err: any) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      showError(t('profile.passwordMismatch'));
      return;
    }
    if (newPassword.length < 4) {
      showError(t('profile.passwordTooShort'));
      return;
    }
    setChangingPw(true);
    try {
      await api.profile.changePassword(oldPassword, newPassword);
      showSuccess(t('profile.passwordChanged'));
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      showError(err.message);
    } finally {
      setChangingPw(false);
    }
  };

  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (loading) return <LoadingText />;
  if (!profile) return <p className="text-gray-500">{t('profile.notFound')}</p>;

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold mb-6">{t('profile.title')}</h1>

      {/* Profile Info */}
      <form onSubmit={handleSaveProfile} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 mb-6">
        <h2 className="text-sm font-semibold text-gray-300">{t('profile.userData')}</h2>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('profile.username')}</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('profile.email')}</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('common.optional')}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span>{t('profile.role')}: <span className="text-gray-300">{profile.role === 'admin' ? t('profile.roleAdmin') : t('profile.roleUser')}</span></span>
          <span>{t('common.created')}: {new Date(profile.createdAt).toLocaleDateString(dateFmtLocale)}</span>
        </div>
        <Button type="submit" variant="primary" disabled={saving || !username.trim()}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </form>

      {/* Language */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 mb-6">
        <h2 className="text-sm font-semibold text-gray-300">{t('profile.language')}</h2>
        <select
          value={localStorage.getItem('devgrimoire_language') || ''}
          onChange={(e) => {
            const lang = e.target.value;
            if (lang) {
              localStorage.setItem('devgrimoire_language', lang);
              i18n.changeLanguage(lang);
            } else {
              localStorage.removeItem('devgrimoire_language');
              const browserLang = navigator.language.startsWith('de') ? 'de' : 'en';
              i18n.changeLanguage(browserLang);
            }
          }}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
        >
          <option value="">{t('profile.languageAuto')}</option>
          <option value="de">{t('profile.languageDe')}</option>
          <option value="en">{t('profile.languageEn')}</option>
        </select>
      </div>

      {/* Change Password */}
      <form onSubmit={handleChangePassword} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">{t('profile.changePassword')}</h2>
        <input
          type="password"
          placeholder={t('profile.currentPassword')}
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
          autoComplete="current-password"
        />
        <input
          type="password"
          placeholder={t('profile.newPassword')}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder={t('profile.confirmPassword')}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
          autoComplete="new-password"
        />
        <Button type="submit" variant="primary" disabled={changingPw || !oldPassword || !newPassword || !confirmPassword}>
          {changingPw ? t('profile.changingPassword') : t('profile.changePassword')}
        </Button>
      </form>
    </div>
  );
}
