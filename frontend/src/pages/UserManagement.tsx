import { useEffect, useState } from 'react';
import { api, UserInfo } from '../api/client';
import { useToast } from '../components/Toast';

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
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
      showSuccess('Benutzer erstellt');
      setUsername('');
      setEmail('');
      setPassword('');
      setRole('user');
      setOpen(false);
      onCreated();
    } catch (err: any) {
      showError(err.message || 'Fehler beim Erstellen');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-6 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
      >
        + Neuer Benutzer
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 max-w-md">
      <h3 className="text-sm font-semibold text-gray-300">Neuen Benutzer anlegen</h3>
      <input
        type="text"
        placeholder="Benutzername *"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        autoFocus
      />
      <input
        type="email"
        placeholder="E-Mail (optional)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
      />
      <input
        type="password"
        placeholder="Passwort *"
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
        <option value="user">Benutzer</option>
        <option value="admin">Administrator</option>
      </select>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !username.trim() || !password}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
        >
          {saving ? 'Speichern...' : 'Erstellen'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

export default function UserManagement() {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Partial<UserInfo>>({});
  const { showError, showSuccess } = useToast();

  const loadUsers = async () => {
    try {
      const data = await api.users.list();
      setUsers(data);
    } catch (err: any) {
      showError(err.message || 'Fehler beim Laden');
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
      showSuccess(user.active ? 'Benutzer deaktiviert' : 'Benutzer aktiviert');
      loadUsers();
    } catch (err: any) {
      showError(err.message);
    }
  };

  const handleDelete = async (user: UserInfo) => {
    try {
      await api.users.delete(user._id);
      showSuccess('Benutzer gelöscht');
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
      showSuccess('Benutzer aktualisiert');
      setEditingId(null);
      loadUsers();
    } catch (err: any) {
      showError(err.message);
    }
  };

  if (loading) return <p className="text-gray-500">Laden...</p>;

  return (
    <div>
      <CreateUserForm onCreated={loadUsers} />

      <div className="space-y-2">
        {users.map((user) => (
          <div
            key={user._id}
            className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-4"
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
                  <option value="user">Benutzer</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="button"
                  onClick={saveEdit}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded"
                >
                  Speichern
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded"
                >
                  Abbrechen
                </button>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{user.username}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        user.role === 'admin'
                          ? 'bg-purple-900 text-purple-300'
                          : 'bg-gray-800 text-gray-400'
                      }`}
                    >
                      {user.role === 'admin' ? 'Admin' : 'Benutzer'}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        user.active
                          ? 'bg-green-900 text-green-300'
                          : 'bg-red-900 text-red-300'
                      }`}
                    >
                      {user.active ? 'Aktiv' : 'Deaktiviert'}
                    </span>
                  </div>
                  {user.email && (
                    <span className="text-xs text-gray-500">{user.email}</span>
                  )}
                </div>
                <span className="text-xs text-gray-600">
                  {new Date(user.createdAt).toLocaleDateString('de-DE')}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(user)}
                    className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded"
                  >
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleActive(user)}
                    className={`px-2 py-1 text-xs rounded ${
                      user.active
                        ? 'bg-yellow-900/40 hover:bg-yellow-900 text-yellow-300'
                        : 'bg-green-900/40 hover:bg-green-900 text-green-300'
                    }`}
                  >
                    {user.active ? 'Deaktivieren' : 'Aktivieren'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(user)}
                    className="px-2 py-1 text-xs bg-red-900/40 hover:bg-red-900 text-red-300 rounded"
                  >
                    Löschen
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
