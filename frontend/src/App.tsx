import { Routes, Route, NavLink, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import ProjectSettings from './pages/ProjectSettings';
import Docs from './pages/Docs';

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

function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-6">
          <NavLink to="/" className="text-xl font-bold text-white tracking-tight">
            ClaudeVault
          </NavLink>
          <nav className="flex gap-4 text-sm">
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
              Dokumentation
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/projects/:id/settings" element={<ProjectSettings />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
