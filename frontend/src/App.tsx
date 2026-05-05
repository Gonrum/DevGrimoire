import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Dashboard from './pages/Dashboard';
import ProjectsOverview from './pages/ProjectsOverview';
import ProjectDetail from './pages/ProjectDetail';
import ProjectCreatePage from './pages/ProjectCreatePage';
import CustomersOverview from './pages/CustomersOverview';
import CustomerDetail from './pages/CustomerDetail';
import CustomerCreatePage from './pages/CustomerCreatePage';
import CustomerEditPage from './pages/CustomerEditPage';
import CustomerProjectLinkCreatePage from './pages/CustomerProjectLinkCreatePage';
import CustomerProjectLinkEditPage from './pages/CustomerProjectLinkEditPage';
import ProjectSettings from './pages/ProjectSettings';
import TodoDetailPage from './pages/TodoDetailPage';
import TodoCreatePage from './pages/TodoCreatePage';
import MilestoneCreatePage from './pages/MilestoneCreatePage';
import MilestoneDetailPage from './pages/MilestoneDetailPage';
import EnvironmentCreatePage from './pages/EnvironmentCreatePage';
import SecretCreatePage from './pages/SecretCreatePage';
import RecurringTaskCreatePage from './pages/RecurringTaskCreatePage';
import RecurringTaskDetailPage from './pages/RecurringTaskDetailPage';
import RecurringTasksPage from './pages/RecurringTasksPage';
import Docs from './pages/Docs';
import Settings from './pages/Settings';
import Login from './pages/Login';
import Profile from './pages/Profile';
import NotificationBell from './components/NotificationBell';
import ConnectionStatus from './components/ConnectionStatus';
import GlobalSearch from './components/GlobalSearch';
import { ToastProvider } from './components/Toast';
import { LoadingText } from './components/ui/LoadingSpinner';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { configureAuth, api } from './api/client';
import ParticleBackground from './components/ParticleBackground';
import QuestionDialog from './components/QuestionDialog';
import ChatDock from './components/ChatDock';

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="text-center py-20">
      <h1 className="text-4xl font-bold text-gray-500 mb-4">404</h1>
      <p className="text-gray-400 mb-6">Seite nicht gefunden.</p>
      <Link to="/" className="text-cyan-400 hover:text-blue-300">
        {t('nav.dashboard')}
      </Link>
    </div>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { authEnabled, user, logout } = useAuth();
  if (!authEnabled) return null;

  return (
    <div className="flex items-center gap-2">
      <NavLink
        to="/profile"
        className={({ isActive }) =>
          `text-sm transition-colors ${isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'}`
        }
        title={t('nav.profile')}
      >
        {user?.username || t('nav.profile')}
      </NavLink>
      <button
        type="button"
        onClick={logout}
        className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        title={t('nav.logout')}
      >
        {t('nav.logout')}
      </button>
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, authEnabled, loading, getAccessToken } = useAuth();

  useEffect(() => {
    const REFRESH_TOKEN_KEY = 'devgrimoire_refresh_token';
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
        <LoadingText />
      </div>
    );
  }

  if (authEnabled && !isAuthenticated) {
    return <Login />;
  }

  return <>{children}</>;
}

function AppShell() {
  const { t } = useTranslation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isSlaveMode, setIsSlaveMode] = useState(false);
  const location = useLocation();

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  // Check replication role
  useEffect(() => {
    api.replication.getStatus()
      .then((s) => setIsSlaveMode(s.role === 'slave'))
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen flex flex-col relative">
      <ParticleBackground />
      <QuestionDialog />
      {isSlaveMode && (
        <div className="bg-amber-900/60 border-b border-amber-700 px-4 py-1.5 text-center text-xs text-amber-200 relative z-40">
          {t('replication.slaveBanner')}
        </div>
      )}
      <header className="bg-gray-900/95 border-b border-gray-800 px-4 sm:px-6 py-3 sm:py-4 grimoire-header relative z-30" style={{ paddingTop: 'max(0.75rem, var(--sat))', paddingLeft: 'max(1rem, var(--sal))', paddingRight: 'max(1rem, var(--sar))' }}>
        <div className="flex items-center gap-3 sm:gap-6">
          {/* Hamburger button - mobile only */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden text-gray-400 hover:text-gray-200 p-1.5 -ml-1"
            aria-label="Menu"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              {mobileMenuOpen ? (
                <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
              ) : (
                <><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></>
              )}
            </svg>
          </button>

          <NavLink to="/" className="flex items-center gap-2 shrink-0" onClick={() => setMobileMenuOpen(false)}>
            <img src="/logo.png" alt="DevGrimoire" className="h-7 sm:h-8" />
            <span className="text-lg sm:text-xl font-bold text-white tracking-tight font-grimoire">DevGrimoire</span>
          </NavLink>

          {/* Desktop nav */}
          <nav className="hidden md:flex gap-4 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              {t('nav.dashboard')}
            </NavLink>
            <NavLink
              to="/projects"
              end
              className={({ isActive }) =>
                isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              {t('nav.projects')}
            </NavLink>
            <NavLink
              to="/customers"
              end
              className={({ isActive }) =>
                isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              {t('nav.customers')}
            </NavLink>
            <NavLink
              to="/recurring-tasks"
              className={({ isActive }) =>
                isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              {t('nav.recurringTasks')}
            </NavLink>
            <NavLink
              to="/docs"
              className={({ isActive }) =>
                isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              {t('nav.docs')}
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
              }
            >
              {t('nav.settings')}
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <GlobalSearch />
            <ConnectionStatus />
            <NotificationBell />
            <UserMenu />
          </div>
        </div>

        {/* Mobile nav drawer */}
        {mobileMenuOpen && (
          <nav className="md:hidden border-t border-gray-800 mt-3 pt-3 pb-1 flex flex-col gap-1">
            <NavLink
              to="/"
              end
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive ? 'text-cyan-400 bg-gray-800' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`
              }
            >
              {t('nav.dashboard')}
            </NavLink>
            <NavLink
              to="/projects"
              end
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive ? 'text-cyan-400 bg-gray-800' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`
              }
            >
              {t('nav.projects')}
            </NavLink>
            <NavLink
              to="/customers"
              end
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive ? 'text-cyan-400 bg-gray-800' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`
              }
            >
              {t('nav.customers')}
            </NavLink>
            <NavLink
              to="/recurring-tasks"
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive ? 'text-cyan-400 bg-gray-800' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`
              }
            >
              {t('nav.recurringTasks')}
            </NavLink>
            <NavLink
              to="/docs"
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive ? 'text-cyan-400 bg-gray-800' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`
              }
            >
              {t('nav.docs')}
            </NavLink>
            <NavLink
              to="/settings"
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `px-3 py-2.5 rounded-lg text-sm transition-colors ${isActive ? 'text-cyan-400 bg-gray-800' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`
              }
            >
              {t('nav.settings')}
            </NavLink>
          </nav>
        )}
      </header>
      <main className="flex-1 w-full px-4 sm:px-6 py-4 sm:py-8 relative z-10" style={{ paddingBottom: 'max(1rem, var(--sab))', paddingLeft: 'max(1rem, var(--sal))', paddingRight: 'max(1rem, var(--sar))' }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects" element={<ProjectsOverview />} />
          <Route path="/projects/new" element={<ProjectCreatePage />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/customers" element={<CustomersOverview />} />
          <Route path="/customers/new" element={<CustomerCreatePage />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/customers/:id/edit" element={<CustomerEditPage />} />
          <Route path="/customers/:id/links/new" element={<CustomerProjectLinkCreatePage />} />
          <Route path="/customers/:id/links/:linkId/edit" element={<CustomerProjectLinkEditPage />} />
          <Route path="/projects/:id/todos/new" element={<TodoCreatePage />} />
          <Route path="/projects/:id/todos/:todoId" element={<TodoDetailPage />} />
          <Route path="/projects/:id/milestones/new" element={<MilestoneCreatePage />} />
          <Route path="/projects/:id/milestones/:milestoneId" element={<MilestoneDetailPage />} />
          <Route path="/projects/:id/environments/new" element={<EnvironmentCreatePage />} />
          <Route path="/projects/:id/secrets/new" element={<SecretCreatePage />} />
          <Route path="/projects/:id/recurring-tasks/new" element={<RecurringTaskCreatePage />} />
          <Route path="/projects/:id/recurring-tasks/:recurringTaskId" element={<RecurringTaskDetailPage />} />
          <Route path="/recurring-tasks" element={<RecurringTasksPage />} />
          <Route path="/recurring-tasks/new" element={<RecurringTaskCreatePage />} />
          <Route path="/recurring-tasks/:recurringTaskId" element={<RecurringTaskDetailPage />} />
          <Route path="/projects/:id/settings" element={<ProjectSettings />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <ChatDock />
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
