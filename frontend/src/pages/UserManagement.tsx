import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, UserInfo } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import ConfirmButton from '../components/ui/ConfirmButton';

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [saving, setSaving] = useState(false);
  const { showError, showSuccess } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSaving(true);
    try {
      await api.users.create({
        username: username.trim(),
        email: email.trim() || undefined,
        password,
        role,
      });
      showSuccess(t('users.userCreated'));
      setUsername('');
      setEmail('');
      setPassword('');
      setRole('user');
      setOpen(false);
      onCreated();
    } catch (err: any) {
      showError(err.message || t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="primary" size="lg" onClick={() => setOpen(true)} className="mb-6">
        {t('users.newUser')}
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 max-w-md">
      <h3 className="text-sm font-semibold text-gray-300">{t('users.createUser')}</h3>
      <input
        type="text"
        placeholder={t('users.usernamePlaceholder')}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        autoFocus
      />
      <input
        type="email"
        placeholder={t('users.emailPlaceholder')}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
      />
      <input
        type="password"
        placeholder={t('users.passwordPlaceholder')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        autoComplete="new-password"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
      >
        <option value="user">{t('users.roleUser')}</option>
        <option value="admin">{t('users.roleAdmin')}</option>
      </select>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={saving || !username.trim() || !password}>
          {saving ? t('common.saving') : t('common.create')}
        </Button>
        <Button type="button" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export default function UserManagement() {
  const { t, i18n } = useTranslation();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Partial<UserInfo>>({});
  const { showError, showSuccess } = useToast();

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const loadUsers = async () => {
    try {
      const data = await api.users.list();
      setUsers(data);
    } catch (err: any) {
      showError(err.message || t('common.errorLoading', { error: '' }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleToggleActive = async (user: UserInfo) => {
    try {
      await api.users.update(user._id, { active: !user.active });
      showSuccess(user.active ? t('users.userDeactivated') : t('users.userActivated'));
      loadUsers();
    } catch (err: any) {
      showError(err.message);
    }
  };

  const handleDelete = async (user: UserInfo) => {
    try {
      await api.users.delete(user._id);
      showSuccess(t('users.userDeleted'));
      loadUsers();
    } catch (err: any) {
      showError(err.message);
    }
  };

  const startEdit = (user: UserInfo) => {
    setEditingId(user._id);
    setEditData({ username: user.username, email: user.email || '', role: user.role });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await api.users.update(editingId, editData);
      showSuccess(t('users.userUpdated'));
      setEditingId(null);
      loadUsers();
    } catch (err: any) {
      showError(err.message);
    }
  };

  if (loading) return <p className="text-gray-500">{t('common.loading')}</p>;

  return (
    <div>
      <CreateUserForm onCreated={loadUsers} />

      <div className="space-y-2">
        {users.map((user) => (
          <Card
            key={user._id}
            padding="none"
            className="px-4 py-3 flex items-center gap-4"
          >
            {editingId === user._id ? (
              <div className="flex-1 flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={editData.username || ''}
                  onChange={(e) => setEditData({ ...editData, username: e.target.value })}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                  placeholder="Username"
                />
                <input
                  type="email"
                  value={editData.email || ''}
                  onChange={(e) => setEditData({ ...editData, email: e.target.value })}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                  placeholder="E-Mail"
                />
                <select
                  value={editData.role || 'user'}
                  onChange={(e) => setEditData({ ...editData, role: e.target.value as 'admin' | 'user' })}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                >
                  <option value="user">{t('users.roleUser')}</option>
                  <option value="admin">Admin</option>
                </select>
                <Button type="button" variant="primary" size="xs" onClick={saveEdit}>
                  {t('common.save')}
                </Button>
                <Button type="button" size="xs" onClick={() => setEditingId(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{user.username}</span>
                    <Badge color={user.role === 'admin' ? 'bg-purple-900 text-purple-300' : 'bg-gray-800 text-gray-400'}>
                      {user.role === 'admin' ? 'Admin' : t('users.roleUser')}
                    </Badge>
                    <Badge color={user.active ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}>
                      {user.active ? t('users.statusActive') : t('users.statusInactive')}
                    </Badge>
                  </div>
                  {user.email && (
                    <span className="text-xs text-gray-500">{user.email}</span>
                  )}
                </div>
                <span className="text-xs text-gray-600">
                  {new Date(user.createdAt).toLocaleDateString(dateLocale)}
                </span>
                <div className="flex gap-1">
                  <Button type="button" size="xs" onClick={() => startEdit(user)}>
                    {t('common.edit')}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => handleToggleActive(user)}
                    className={user.active
                      ? 'bg-yellow-900/40 hover:bg-yellow-900 text-yellow-300'
                      : 'bg-green-900/40 hover:bg-green-900 text-green-300'}
                  >
                    {user.active ? t('users.deactivate') : t('users.activate')}
                  </Button>
                  <ConfirmButton onConfirm={() => handleDelete(user)} size="xs" />
                </div>
              </>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
