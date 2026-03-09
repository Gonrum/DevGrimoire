import { useEffect, useState } from 'react';
import { api, UserInfo } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { LoadingText } from '../components/ui/LoadingSpinner';

export default function Profile() {
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
      showSuccess('Profil aktualisiert');
    } catch (err: any) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      showError('Passwörter stimmen nicht überein');
      return;
    }
    if (newPassword.length < 4) {
      showError('Passwort muss mindestens 4 Zeichen lang sein');
      return;
    }
    setChangingPw(true);
    try {
      await api.profile.changePassword(oldPassword, newPassword);
      showSuccess('Passwort geändert');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      showError(err.message);
    } finally {
      setChangingPw(false);
    }
  };

  if (loading) return <LoadingText />;
  if (!profile) return <p className="text-gray-500">Profil nicht gefunden.</p>;

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Profil</h1>

      {/* Profile Info */}
      <form onSubmit={handleSaveProfile} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 mb-6">
        <h2 className="text-sm font-semibold text-gray-300">Benutzerdaten</h2>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Benutzername</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">E-Mail</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Optional"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span>Rolle: <span className="text-gray-300">{profile.role === 'admin' ? 'Administrator' : 'Benutzer'}</span></span>
          <span>Erstellt: {new Date(profile.createdAt).toLocaleDateString('de-DE')}</span>
        </div>
        <Button type="submit" variant="primary" disabled={saving || !username.trim()}>
          {saving ? 'Speichern...' : 'Speichern'}
        </Button>
      </form>

      {/* Change Password */}
      <form onSubmit={handleChangePassword} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">Passwort ändern</h2>
        <input
          type="password"
          placeholder="Aktuelles Passwort"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          autoComplete="current-password"
        />
        <input
          type="password"
          placeholder="Neues Passwort"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder="Neues Passwort bestätigen"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          autoComplete="new-password"
        />
        <Button type="submit" variant="primary" disabled={changingPw || !oldPassword || !newPassword || !confirmPassword}>
          {changingPw ? 'Ändern...' : 'Passwort ändern'}
        </Button>
      </form>
    </div>
  );
}
