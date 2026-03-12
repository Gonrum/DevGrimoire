import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import Button from '../components/ui/Button';

export default function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setError(null);
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err.message || t('auth.loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      <img
        src="/logo.png"
        alt=""
        className="pointer-events-none select-none fixed bottom-[-5%] right-[-5%] w-[50vw] max-w-[600px]"
      />
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <img src="/logo.png" alt="DevGrimoire" className="h-20 mb-3" />
          <h1 className="text-2xl font-bold text-center">DevGrimoire</h1>
          <p className="text-gray-500 text-sm text-center mt-1">{t('auth.loginSubtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
          {error && (
            <div className="bg-red-900/20 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="username" className="block text-xs text-gray-500 mb-1">{t('auth.username')}</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
              autoFocus
              autoComplete="username"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs text-gray-500 mb-1">{t('auth.password')}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
              autoComplete="current-password"
            />
          </div>

          <Button type="submit" variant="primary" size="lg" disabled={loading || !username.trim() || !password} className="w-full">
            {loading ? t('auth.loggingIn') : t('auth.login')}
          </Button>
        </form>
      </div>
    </div>
  );
}
