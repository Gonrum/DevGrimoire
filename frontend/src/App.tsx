import { useEffect } from 'react';
import { Routes, Route, NavLink, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import ProjectSettings from './pages/ProjectSettings';
import TodoDetailPage from './pages/TodoDetailPage';
import TodoCreatePage from './pages/TodoCreatePage';
import MilestoneCreatePage from './pages/MilestoneCreatePage';
import Docs from './pages/Docs';
import Login from './pages/Login';
import { usePushNotifications } from './hooks/usePushNotifications';
import { ToastProvider } from './components/Toast';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { configureAuth } from './api/client';

function NotFound() {
  return (
    <div className="text-center py-20">
      <h1 className="text-4xl font-bold text-gray-500 mb-4">404</h1>
      <p className="text-gray-400 mb-6">Seite nicht gefunden.</p>
      <Link to="/" className="text-blue-400 hover:text-blue-300">
        Zum Dashboard
      </Link>
    </div>
  );
}

function PushToggle() {
  const { supported, subscribed, loading, subscribe, unsubscribe } = usePushNotifications();
  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={subscribed ? unsubscribe : subscribe}
      disabled={loading}
      className={`text-sm px-2 py-1 rounded transition-colors ${subscribed ? 'text-blue-400 hover:text-blue-300' : 'text-gray-500 hover:text-gray-300'}`}
      title={subscribed ? 'Push-Benachrichtigungen deaktivieren' : 'Push-Benachrichtigungen aktivieren'}
    >
      {subscribed ? '\u{1F514}' : '\u{1F515}'}
    </button>
  );
}

function LogoutButton() {
  const { authEnabled, logout } = useAuth();
  if (!authEnabled) return null;

  return (
    <button
      type="button"
      onClick={logout}
      className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
      title="Abmelden"
    >
      Abmelden
    </button>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, authEnabled, loading, getAccessToken } = useAuth();

  // Wire up the API client with auth
  useEffect(() => {
    const REFRESH_TOKEN_KEY = 'claudevault_refresh_token';
    configureAuth(
      getAccessToken,
      async () => {
        const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
        if (!refreshToken) return false;
        try {
          const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
          });
          if (!res.ok) return false;
          const data = await res.json();
          localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
          // The AuthProvider will update the token via its own refresh logic
          return true;
        } catch {
          return false;
        }
      },
    );
  }, [getAccessToken]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Laden...</p>
      </div>
    );
  }

  if (authEnabled && !isAuthenticated) {
    return <Login />;
  }

  return <>{children}</>;
}

function AppShell() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-900 border-b border-gray-800 px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center gap-3 sm:gap-6">
          <NavLink to="/" className="text-lg sm:text-xl font-bold text-white tracking-tight shrink-0">
            ClaudeVault
          </NavLink>
          <nav className="flex gap-3 sm:gap-4 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/docs"
              className={({ isActive }) =>
                isActive ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              Docs
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <PushToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="flex-1 w-full px-4 sm:px-6 py-4 sm:py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/projects/:id/todos/new" element={<TodoCreatePage />} />
          <Route path="/projects/:id/todos/:todoId" element={<TodoDetailPage />} />
          <Route path="/projects/:id/milestones/new" element={<MilestoneCreatePage />} />
          <Route path="/projects/:id/settings" element={<ProjectSettings />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AuthGate>
          <AppShell />
        </AuthGate>
      </ToastProvider>
    </AuthProvider>
  );
}

export default App;
