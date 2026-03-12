import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

type DocsSection = 'overview' | 'setup' | 'auth' | 'mcp' | 'api' | 'architecture';

export default function Docs() {
  const [active, setActive] = useState<DocsSection>('overview');
  const { t } = useTranslation();

  const sections: { key: DocsSection; label: string }[] = [
    { key: 'overview', label: t('docs.navOverview') },
    { key: 'setup', label: t('docs.navSetup') },
    { key: 'auth', label: t('docs.navAuth') },
    { key: 'mcp', label: t('docs.navMcp') },
    { key: 'api', label: t('docs.navApi') },
    { key: 'architecture', label: t('docs.navArchitecture') },
  ];

  return (
    <div className="max-w-5xl mx-auto flex gap-8">
      {/* Sidebar Navigation */}
      <nav className="hidden md:block shrink-0 w-44 sticky top-8 self-start">
        <ul className="space-y-1">
          {sections.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => setActive(s.key)}
                className={`w-full text-left px-3 py-1.5 text-sm rounded transition-colors ${
                  active === s.key
                    ? 'bg-gray-800 text-cyan-400 font-medium'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Mobile Tab Bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 px-2 py-1.5 flex gap-1 overflow-x-auto z-50">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActive(s.key)}
            className={`px-3 py-1.5 text-xs rounded whitespace-nowrap transition-colors ${
              active === s.key
                ? 'bg-gray-800 text-cyan-400 font-medium'
                : 'text-gray-500'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-16 md:pb-0">
        <h1 className="text-2xl font-bold mb-8">{t('docs.title')}</h1>

        {active === 'overview' && <OverviewSection />}
        {active === 'setup' && <SetupSection />}
        {active === 'auth' && <AuthSection />}
        {active === 'mcp' && <McpSection />}
        {active === 'api' && <ApiSection />}
        {active === 'architecture' && <ArchitectureSection />}
      </div>
    </div>
  );
}

/* ─── Sections ─── */

function OverviewSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Was ist DevGrimoire?' : 'What is DevGrimoire?'}>
        <p className="text-gray-400 leading-relaxed">
          {isDE ? (
            <>
              DevGrimoire gibt Claude (dem AI-Assistenten) ein persistentes
              Ged&auml;chtnis f&uuml;r deine Projekte. Claude kann Projekte tracken,
              Todos und Milestones verwalten, Arbeitssessions dokumentieren,
              Wissen abspeichern, Changelogs pflegen und verschl&uuml;sselte
              Secrets verwalten &mdash; alles &uuml;ber das{' '}
              <span className="text-gray-200">Model Context Protocol (MCP)</span>.
            </>
          ) : (
            <>
              DevGrimoire gives Claude (the AI assistant) persistent memory for
              your projects. Claude can track projects, manage todos and milestones,
              document work sessions, store knowledge, maintain changelogs, and
              manage encrypted secrets &mdash; all via the{' '}
              <span className="text-gray-200">Model Context Protocol (MCP)</span>.
            </>
          )}
        </p>
        <p className="text-gray-400 leading-relaxed mt-3">
          {isDE
            ? 'Das Web-Frontend zeigt dir, was Claude gespeichert hat, und erm\u00f6glicht eigene Verwaltung: Projekte anlegen, Todos bearbeiten, Wissen durchsuchen und vieles mehr.'
            : 'The web frontend shows you what Claude has stored and lets you manage it yourself: create projects, edit todos, search knowledge, and much more.'}
        </p>
      </Section>

      <Section title="Features">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FeatureCard
            title={isDE ? 'Projekte & Todos' : 'Projects & Todos'}
            desc={isDE ? 'Projekte mit Todos, Milestones, Dependencies und Status-Workflow' : 'Projects with todos, milestones, dependencies, and status workflow'}
          />
          <FeatureCard
            title={isDE ? 'Wissensbasis' : 'Knowledge Base'}
            desc={isDE ? 'Wissenseintr\u00e4ge und Recherche mit Volltextsuche' : 'Knowledge entries and research with full-text search'}
          />
          <FeatureCard
            title="Changelog"
            desc={isDE ? 'Versionierte \u00c4nderungshistorie pro Projekt/Komponente' : 'Versioned change history per project/component'}
          />
          <FeatureCard
            title={isDE ? 'Sessions' : 'Sessions'}
            desc={isDE ? 'Arbeitssitzungen mit Zusammenfassung und n\u00e4chsten Schritten' : 'Work sessions with summary and next steps'}
          />
          <FeatureCard
            title="Secrets"
            desc={isDE ? 'AES-256-GCM verschl\u00fcsselte Secrets und Umgebungsvariablen' : 'AES-256-GCM encrypted secrets and environment variables'}
          />
          <FeatureCard
            title={isDE ? 'Globale Suche' : 'Global Search'}
            desc={isDE ? 'Ctrl+K Suche \u00fcber Todos, Wissen, Changelogs, Research, Milestones' : 'Ctrl+K search across todos, knowledge, changelogs, research, milestones'}
          />
          <FeatureCard
            title="Multi-User Auth"
            desc={isDE ? 'JWT-basiert mit Rollen (Admin/User), Profilverwaltung, RBAC' : 'JWT-based with roles (Admin/User), profile management, RBAC'}
          />
          <FeatureCard
            title={isDE ? 'Live-Updates' : 'Live Updates'}
            desc={isDE ? 'SSE-basierte Echtzeit-Updates via MongoDB Change Streams' : 'SSE-based real-time updates via MongoDB Change Streams'}
          />
          <FeatureCard
            title={isDE ? 'Benachrichtigungen' : 'Notifications'}
            desc={isDE ? 'In-App Inbox + optionale Web-Push-Notifications' : 'In-app inbox + optional web push notifications'}
          />
          <FeatureCard
            title="MCP Remote"
            desc={isDE ? 'HTTP/SSE-Zugriff von jedem Rechner im Netzwerk' : 'HTTP/SSE access from any machine on the network'}
          />
        </div>
      </Section>

      <Section title={isDE ? 'Voraussetzungen' : 'Prerequisites'}>
        <ul className="text-gray-400 space-y-1 list-disc list-inside">
          <li>Docker & Docker Compose</li>
          <li>{isDE ? 'Claude Code CLI oder Claude Desktop' : 'Claude Code CLI or Claude Desktop'}</li>
          <li>{isDE ? 'Node.js 22+ (nur f\u00fcr lokale MCP-Server Entwicklung)' : 'Node.js 22+ (only for local MCP server development)'}</li>
        </ul>
      </Section>
    </>
  );
}

function SetupSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Installation' : 'Installation'}>
        <Step n={1} title={isDE ? 'Repository klonen & Umgebung konfigurieren' : 'Clone repository & configure environment'}>
          <Code>{isDE
            ? `git clone <repo-url> DevGrimoire
cd DevGrimoire
cp .env.example .env
# .env anpassen`
            : `git clone <repo-url> DevGrimoire
cd DevGrimoire
cp .env.example .env
# adjust .env`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            {isDE ? (<>Wichtige Variablen in <Mono>.env</Mono>:</>) : (<>Important variables in <Mono>.env</Mono>:</>)}
          </p>
          <div className="mt-2 space-y-1 text-sm text-gray-400">
            <EnvVar name="MONGO_ROOT_PASSWORD" desc={isDE ? 'MongoDB-Passwort' : 'MongoDB password'} />
            <EnvVar name="AUTH_USERNAME / AUTH_PASSWORD" desc={isDE ? 'Initiales Admin-Konto (wird beim Start in DB angelegt)' : 'Initial admin account (created in DB on startup)'} />
            <EnvVar name="JWT_SECRET" desc={isDE ? 'Geheimnis f\u00fcr JWT-Signierung' : 'Secret for JWT signing'} />
            <EnvVar name="SECRETS_ENCRYPTION_KEY" desc={isDE ? 'AES-256-Key f\u00fcr Secrets (64 Hex-Zeichen)' : 'AES-256 key for secrets (64 hex characters)'} />
          </div>
          <Code>{isDE
            ? `# Encryption Key generieren:
openssl rand -hex 32`
            : `# Generate encryption key:
openssl rand -hex 32`}</Code>
        </Step>

        <Step n={2} title={isDE ? 'Docker Stack starten' : 'Start Docker stack'}>
          <Code>{`docker compose up -d`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            {isDE
              ? 'Startet MongoDB (Replica Set), Backend (NestJS) und Frontend (nginx).'
              : 'Starts MongoDB (replica set), backend (NestJS), and frontend (nginx).'}
          </p>
        </Step>
      </Section>

      <Section title={isDE ? 'Remote-Anbindung (HTTP/SSE)' : 'Remote Connection (HTTP/SSE)'}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE ? (
            <>
              Das Backend stellt HTTP-basierte MCP-Endpoints bereit. Claude Code kann von{' '}
              <strong className="text-gray-200">jedem Rechner im Netzwerk</strong>{' '}
              auf DevGrimoire zugreifen &mdash; ohne lokale Installation.
            </>
          ) : (
            <>
              The backend provides HTTP-based MCP endpoints. Claude Code can access
              DevGrimoire from{' '}
              <strong className="text-gray-200">any machine on the network</strong>{' '}
              &mdash; no local installation required.
            </>
          )}
        </p>

        <Step n={1} title="Claude Code CLI">
          <p className="text-gray-400 text-sm mb-2">
            {isDE ? (<>In <Mono>~/.claude.json</Mono>:</>) : (<>In <Mono>~/.claude.json</Mono>:</>)}
          </p>
          <Code>{`{
  "mcpServers": {
    "devgrimoire": {
      "type": "sse",
      "url": "http://[server]/sse"
    }
  }
}`}</Code>
        </Step>

        <Step n={2} title="Claude Desktop App">
          <p className="text-gray-400 text-sm mb-2">
            {isDE ? (
              <>
                Ben&ouml;tigt <Mono>mcp-remote</Mono> als Bridge (Node.js erforderlich).
                In <Mono>claude_desktop_config.json</Mono>:
              </>
            ) : (
              <>
                Requires <Mono>mcp-remote</Mono> as bridge (Node.js required).
                In <Mono>claude_desktop_config.json</Mono>:
              </>
            )}
          </p>
          <Code>{`{
  "mcpServers": {
    "devgrimoire": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://[server]/sse", "--allow-http"]
    }
  }
}`}</Code>
          <Hint>
            {isDE ? (
              <>
                <code className="bg-gray-800 px-1 rounded">--allow-http</code> ist n&ouml;tig, da{' '}
                mcp-remote standardm&auml;&szlig;ig nur HTTPS erlaubt.
                Config-Pfade: macOS <Mono>~/Library/Application Support/Claude/claude_desktop_config.json</Mono>,
                Linux <Mono>~/.config/Claude/claude_desktop_config.json</Mono>
              </>
            ) : (
              <>
                <code className="bg-gray-800 px-1 rounded">--allow-http</code> is required because{' '}
                mcp-remote only allows HTTPS by default.
                Config paths: macOS <Mono>~/Library/Application Support/Claude/claude_desktop_config.json</Mono>,
                Linux <Mono>~/.config/Claude/claude_desktop_config.json</Mono>
              </>
            )}
          </Hint>
        </Step>

        <Step n={3} title={isDE ? 'Web-Frontend aufrufen' : 'Open web frontend'}>
          <p className="text-gray-400 text-sm">
            {isDE
              ? (<>Das Dashboard ist unter <Mono>http://[server]</Mono> erreichbar (Port 80, nginx).</>)
              : (<>The dashboard is available at <Mono>http://[server]</Mono> (port 80, nginx).</>)}
          </p>
        </Step>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mt-4">
          <p className="text-gray-300 text-sm font-medium mb-2">{isDE ? 'Verf\u00fcgbare MCP-Transports' : 'Available MCP Transports'}</p>
          <div className="space-y-2 text-sm text-gray-400">
            <div className="flex gap-3">
              <code className="text-green-400 shrink-0 w-44">GET /sse</code>
              <span>Legacy SSE (Claude Code, Claude Desktop)</span>
            </div>
            <div className="flex gap-3">
              <code className="text-green-400 shrink-0 w-44">POST /messages</code>
              <span>{isDE ? 'Legacy SSE Message-Endpoint' : 'Legacy SSE message endpoint'}</span>
            </div>
            <div className="flex gap-3">
              <code className="text-cyan-400 shrink-0 w-44">POST|GET|DELETE /mcp</code>
              <span>{isDE ? 'Streamable HTTP (neuere Clients)' : 'Streamable HTTP (newer clients)'}</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title={isDE ? 'Lokale Anbindung (stdio)' : 'Local Connection (stdio)'}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE
            ? 'Alternativ kann der MCP-Server lokal per stdio gestartet werden. Node.js und MongoDB m\u00fcssen erreichbar sein.'
            : 'Alternatively, the MCP server can be started locally via stdio. Node.js and MongoDB must be reachable.'}
        </p>

        <Step n={1} title={isDE ? 'Backend lokal bauen' : 'Build backend locally'}>
          <Code>{`cd backend
npm install
NODE_OPTIONS="--max-old-space-size=8192" npm run build`}</Code>
        </Step>

        <Step n={2} title={isDE ? 'MCP-Config einrichten' : 'Configure MCP'}>
          <Code>{isDE
            ? `{
  "mcpServers": {
    "devgrimoire": {
      "command": "node",
      "args": ["/pfad/zu/DevGrimoire/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/devgrimoire?authSource=admin&directConnection=true"
      }
    }
  }
}`
            : `{
  "mcpServers": {
    "devgrimoire": {
      "command": "node",
      "args": ["/path/to/DevGrimoire/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/devgrimoire?authSource=admin&directConnection=true"
      }
    }
  }
}`}</Code>
        </Step>
      </Section>
    </>
  );
}

function AuthSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Authentifizierung' : 'Authentication'}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE ? (
            <>
              DevGrimoire unterst&uuml;tzt Multi-User-Authentifizierung mit rollenbasierter Zugriffskontrolle (RBAC).
              Beim ersten Start wird aus den Env-Variablen <Mono>AUTH_USERNAME</Mono> und <Mono>AUTH_PASSWORD</Mono> ein
              Admin-Benutzer in der Datenbank angelegt. Weitere Benutzer k&ouml;nnen &uuml;ber die Admin-Oberfl&auml;che
              verwaltet werden.
            </>
          ) : (
            <>
              DevGrimoire supports multi-user authentication with role-based access control (RBAC).
              On first startup, an admin user is created in the database from the env variables{' '}
              <Mono>AUTH_USERNAME</Mono> and <Mono>AUTH_PASSWORD</Mono>. Additional users can be
              managed via the admin interface.
            </>
          )}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Access Token" value={isDE ? 'JWT, 15 Minuten g\u00fcltig, im Speicher gehalten' : 'JWT, valid for 15 minutes, kept in memory'} />
          <InfoRow label="Refresh Token" value={isDE ? 'Opak, 7 Tage g\u00fcltig, MongoDB mit TTL, Token-Rotation' : 'Opaque, valid for 7 days, MongoDB with TTL, token rotation'} />
          <InfoRow label="SSE" value={isDE ? 'Auth via ?token=... Query-Parameter (EventSource unterst\u00fctzt keine Header)' : 'Auth via ?token=... query parameter (EventSource does not support headers)'} />
          <InfoRow label="MCP Server" value={isDE ? 'stdio = lokal ohne Auth; HTTP-Endpoints via API Key gesch\u00fctzt' : 'stdio = local without auth; HTTP endpoints protected via API key'} />
          <InfoRow label="API Keys" value={isDE
            ? (<>SHA-256 gehasht, Prefix <Mono>cv_</Mono>, Bearer Header oder <Mono>?apiKey=</Mono> Query</>)
            : (<>SHA-256 hashed, prefix <Mono>cv_</Mono>, Bearer header or <Mono>?apiKey=</Mono> query</>)} />
        </div>
        <Hint>
          {isDE ? (
            <>
              Ohne gesetzte Credentials (<Mono>AUTH_USERNAME</Mono> / <Mono>AUTH_PASSWORD</Mono>) ist die
              Authentifizierung komplett deaktiviert &mdash; alle Endpunkte sind frei zug&auml;nglich.
            </>
          ) : (
            <>
              Without credentials set (<Mono>AUTH_USERNAME</Mono> / <Mono>AUTH_PASSWORD</Mono>),
              authentication is completely disabled &mdash; all endpoints are freely accessible.
            </>
          )}
        </Hint>
      </Section>

      <Section title={isDE ? 'Rollen & Berechtigungen' : 'Roles & Permissions'}>
        <div className="space-y-3">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900 text-purple-300">Admin</span>
              <span className="text-sm text-gray-300 font-medium">{isDE ? 'Administrator' : 'Administrator'}</span>
            </div>
            <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
              <li>{isDE ? 'Voller Zugriff auf alle Funktionen' : 'Full access to all features'}</li>
              <li>{isDE ? 'Benutzerverwaltung (anlegen, bearbeiten, deaktivieren, l\u00f6schen)' : 'User management (create, edit, deactivate, delete)'}</li>
              <li>{isDE ? 'Erster Admin wird aus Env-Variablen beim Start angelegt' : 'First admin is created from env variables on startup'}</li>
            </ul>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">User</span>
              <span className="text-sm text-gray-300 font-medium">{isDE ? 'Benutzer' : 'User'}</span>
            </div>
            <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
              <li>{isDE ? 'Lese-/Schreibzugriff auf Projekte, Todos, Wissen etc.' : 'Read/write access to projects, todos, knowledge, etc.'}</li>
              <li>{isDE ? 'Eigenes Profil bearbeiten und Passwort \u00e4ndern' : 'Edit own profile and change password'}</li>
              <li>{isDE ? 'Kein Zugriff auf Benutzerverwaltung' : 'No access to user management'}</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section title={isDE ? 'Benutzerverwaltung' : 'User Management'}>
        <p className="text-gray-400 text-sm mb-3">
          {isDE ? (
            <>
              Admins finden die Benutzerverwaltung unter <Mono>Einstellungen &rarr; Benutzerverwaltung</Mono>.
              Dort k&ouml;nnen Benutzer angelegt, bearbeitet, deaktiviert und gel&ouml;scht werden.
            </>
          ) : (
            <>
              Admins can find user management under <Mono>Settings &rarr; User Management</Mono>.
              Users can be created, edited, deactivated, and deleted there.
            </>
          )}
        </p>
        <p className="text-gray-400 text-sm">
          {isDE ? (
            <>
              Jeder Benutzer kann unter <Mono>Profil</Mono> (Klick auf den Benutzernamen in der Topbar) seinen
              Benutzernamen, E-Mail und Passwort &auml;ndern.
            </>
          ) : (
            <>
              Every user can change their username, email, and password under{' '}
              <Mono>Profile</Mono> (click on the username in the top bar).
            </>
          )}
        </p>
      </Section>

      <Section title="API Keys (MCP Auth)">
        <p className="text-gray-400 text-sm mb-4">
          {isDE ? (
            <>
              API Keys erm&ouml;glichen authentifizierten Zugriff auf die MCP-Endpoints (<Mono>/mcp</Mono>, <Mono>/sse</Mono>, <Mono>/messages</Mono>)
              und die REST API. Keys werden SHA-256 gehasht gespeichert und k&ouml;nnen unter{' '}
              <Mono>Einstellungen &rarr; API Keys</Mono> verwaltet werden.
            </>
          ) : (
            <>
              API keys enable authenticated access to the MCP endpoints (<Mono>/mcp</Mono>, <Mono>/sse</Mono>, <Mono>/messages</Mono>)
              and the REST API. Keys are stored SHA-256 hashed and can be managed under{' '}
              <Mono>Settings &rarr; API Keys</Mono>.
            </>
          )}
        </p>

        <Step n={1} title={isDE ? 'API Key erstellen' : 'Create API Key'}>
          <p className="text-gray-400 text-sm">
            {isDE ? (
              <>
                Unter <Mono>Einstellungen &rarr; API Keys &rarr; Erstellen</Mono>. Der Plaintext-Key wird
                <strong className="text-gray-200"> nur einmalig</strong> angezeigt &mdash; sofort kopieren!
              </>
            ) : (
              <>
                Under <Mono>Settings &rarr; API Keys &rarr; Create</Mono>. The plaintext key is shown
                <strong className="text-gray-200"> only once</strong> &mdash; copy it immediately!
              </>
            )}
          </p>
        </Step>

        <Step n={2} title={isDE ? 'MCP-Client konfigurieren' : 'Configure MCP client'}>
          <p className="text-gray-400 text-sm mb-2">
            {isDE ? (<>Claude Code (<Mono>~/.claude.json</Mono>):</>) : (<>Claude Code (<Mono>~/.claude.json</Mono>):</>)}
          </p>
          <Code>{`{
  "mcpServers": {
    "devgrimoire": {
      "type": "sse",
      "url": "http://[server]/sse?apiKey=cv_..."
    }
  }
}`}</Code>
          <p className="text-gray-400 text-sm mt-3 mb-2">
            {isDE ? 'Alternativ per Header (Streamable HTTP):' : 'Alternatively via header (Streamable HTTP):'}
          </p>
          <Code>{`{
  "mcpServers": {
    "devgrimoire": {
      "type": "http",
      "url": "http://[server]/mcp",
      "headers": {
        "Authorization": "Bearer cv_..."
      }
    }
  }
}`}</Code>
        </Step>

        <Step n={3} title={isDE ? 'REST API mit API Key' : 'REST API with API Key'}>
          <p className="text-gray-400 text-sm mb-2">
            {isDE ? 'API Keys funktionieren auch f\u00fcr die REST API:' : 'API keys also work for the REST API:'}
          </p>
          <Code>{`# Header
curl -H "Authorization: Bearer cv_..." http://[server]/api/projects

# Query Parameter
curl http://[server]/api/projects?apiKey=cv_...`}</Code>
        </Step>

        <div className="space-y-2 text-sm text-gray-400 mt-4">
          <InfoRow label="Prefix" value={isDE
            ? (<><Mono>cv_</Mono> + 64 Hex-Zeichen (32 Bytes random)</>)
            : (<><Mono>cv_</Mono> + 64 hex characters (32 bytes random)</>)} />
          <InfoRow label={isDE ? 'Speicherung' : 'Storage'} value={isDE ? 'Nur SHA-256 Hash in der Datenbank' : 'Only SHA-256 hash stored in database'} />
          <InfoRow label={isDE ? 'Ablauf' : 'Expiry'} value={isDE ? 'Optional, bei Erstellung konfigurierbar' : 'Optional, configurable at creation'} />
          <InfoRow label="Scope" value={isDE ? 'Gleiche Rechte wie User-Rolle' : 'Same permissions as User role'} />
        </div>

        <Hint>
          {isDE ? (
            <>
              Wenn Auth nicht aktiviert ist (keine <Mono>AUTH_USERNAME</Mono> / <Mono>AUTH_PASSWORD</Mono>),
              sind alle Endpoints inkl. MCP frei zug&auml;nglich &mdash; API Keys werden nicht ben&ouml;tigt.
            </>
          ) : (
            <>
              If auth is not enabled (no <Mono>AUTH_USERNAME</Mono> / <Mono>AUTH_PASSWORD</Mono>),
              all endpoints including MCP are freely accessible &mdash; API keys are not required.
            </>
          )}
        </Hint>
      </Section>

      <Section title={isDE ? 'Secrets & Verschl\u00fcsselung' : 'Secrets & Encryption'}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE
            ? 'Secrets werden mit AES-256-GCM verschl\u00fcsselt in MongoDB gespeichert. Jedes Secret hat einen eigenen zuf\u00e4lligen IV.'
            : 'Secrets are stored AES-256-GCM encrypted in MongoDB. Each secret has its own random IV.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Algorithmus' : 'Algorithm'} value="AES-256-GCM (Authenticated Encryption)" />
          <InfoRow label="Key" value={<><Mono>SECRETS_ENCRYPTION_KEY</Mono> ({isDE ? '64 Hex-Zeichen = 32 Bytes' : '64 hex characters = 32 bytes'})</>} />
          <InfoRow label={isDE ? 'Speicherformat' : 'Storage format'} value={<><Mono>iv:authTag:ciphertext</Mono> (Hex)</>} />
          <InfoRow label={isDE ? 'List-Endpoint' : 'List endpoint'} value={isDE ? 'Gibt nur Keys + Beschreibung zur\u00fcck, niemals Werte' : 'Returns only keys + description, never values'} />
          <InfoRow label={isDE ? 'Entschl\u00fcsselung' : 'Decryption'} value={isDE
            ? (<>Nur via <Mono>GET /api/secrets/:id</Mono> oder <Mono>secret_get</Mono></>)
            : (<>Only via <Mono>GET /api/secrets/:id</Mono> or <Mono>secret_get</Mono></>)} />
        </div>
        <Hint>
          {isDE ? (
            <>
              Ohne gesetzten <Mono>SECRETS_ENCRYPTION_KEY</Mono> ist das
              Secrets-Feature deaktiviert.
            </>
          ) : (
            <>
              Without a set <Mono>SECRETS_ENCRYPTION_KEY</Mono>, the
              secrets feature is disabled.
            </>
          )}
        </Hint>
      </Section>
    </>
  );
}

function McpSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'MCP-Tools (49)' : 'MCP Tools (49)'}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE
            ? 'Nach dem Anbinden stehen Claude 49 Tools zur Verf\u00fcgung. List-Tools liefern kompakte \u00dcbersichten, Details nur via _get Tools.'
            : 'After connecting, Claude has access to 49 tools. List tools return compact overviews, details only via _get tools.'}
        </p>

        <ToolGroup title={isDE ? 'Projekte' : 'Projects'} tools={[
          { name: 'project_create', desc: isDE ? 'Neues Projekt anlegen' : 'Create new project' },
          { name: 'project_list', desc: isDE ? 'Alle Projekte auflisten' : 'List all projects' },
          { name: 'project_get', desc: isDE ? 'Projekt per ID oder Name abrufen' : 'Get project by ID or name' },
          { name: 'project_update', desc: isDE ? 'Projekt aktualisieren' : 'Update project' },
          { name: 'project_delete', desc: isDE ? 'Projekt und alle Daten l\u00f6schen' : 'Delete project and all data' },
        ]} />

        <ToolGroup title="Todos" tools={[
          { name: 'todo_create', desc: isDE ? 'Todo anlegen (Status, Priorit\u00e4t, Tags, Milestone)' : 'Create todo (status, priority, tags, milestone)' },
          { name: 'todo_list', desc: isDE ? 'Todos filtern nach Projekt/Status/Priorit\u00e4t' : 'Filter todos by project/status/priority' },
          { name: 'todo_get', desc: isDE ? 'Einzelnes Todo mit Details und Kommentaren' : 'Single todo with details and comments' },
          { name: 'todo_update', desc: isDE ? 'Status, Priorit\u00e4t, Dependencies \u00e4ndern' : 'Change status, priority, dependencies' },
          { name: 'todo_delete', desc: isDE ? 'Todo l\u00f6schen' : 'Delete todo' },
          { name: 'todo_comment', desc: isDE ? 'Kommentar an ein Todo anh\u00e4ngen' : 'Add comment to a todo' },
        ]} />

        <ToolGroup title="Milestones" tools={[
          { name: 'milestone_create', desc: isDE ? 'Milestone/Epic anlegen' : 'Create milestone/epic' },
          { name: 'milestone_list', desc: isDE ? 'Milestones eines Projekts auflisten' : 'List milestones for a project' },
          { name: 'milestone_get', desc: isDE ? 'Einzelnen Milestone abrufen' : 'Get single milestone' },
          { name: 'milestone_update', desc: isDE ? 'Milestone aktualisieren' : 'Update milestone' },
          { name: 'milestone_delete', desc: isDE ? 'Milestone l\u00f6schen' : 'Delete milestone' },
        ]} />

        <ToolGroup title="Sessions" tools={[
          { name: 'session_save', desc: isDE ? 'Arbeitssession speichern (Zusammenfassung, Dateien, n\u00e4chste Schritte)' : 'Save work session (summary, files, next steps)' },
          { name: 'session_get', desc: isDE ? 'Letzte Session(s) eines Projekts abrufen' : 'Get latest session(s) for a project' },
        ]} />

        <ToolGroup title={isDE ? 'Wissen' : 'Knowledge'} tools={[
          { name: 'knowledge_save', desc: isDE ? 'Wissenseintrag speichern (Architektur, Patterns, Notizen)' : 'Save knowledge entry (architecture, patterns, notes)' },
          { name: 'knowledge_search', desc: isDE ? 'Volltextsuche in der Wissensbasis' : 'Full-text search in knowledge base' },
          { name: 'knowledge_list', desc: isDE ? 'Alle Eintr\u00e4ge eines Projekts auflisten' : 'List all entries for a project' },
          { name: 'knowledge_get', desc: isDE ? 'Einzelnen Wissenseintrag mit vollem Inhalt' : 'Get single knowledge entry with full content' },
          { name: 'knowledge_update', desc: isDE ? 'Eintrag aktualisieren' : 'Update entry' },
          { name: 'knowledge_delete', desc: isDE ? 'Eintrag l\u00f6schen' : 'Delete entry' },
        ]} />

        <ToolGroup title="Changelog" tools={[
          { name: 'changelog_add', desc: isDE ? 'Eintrag hinzuf\u00fcgen (Version, Changes, Component)' : 'Add entry (version, changes, component)' },
          { name: 'changelog_list', desc: isDE ? 'Changelog eines Projekts auflisten' : 'List changelog for a project' },
          { name: 'changelog_get', desc: isDE ? 'Einzelnen Eintrag abrufen' : 'Get single entry' },
          { name: 'changelog_update', desc: isDE ? 'Eintrag aktualisieren' : 'Update entry' },
          { name: 'changelog_delete', desc: isDE ? 'Eintrag l\u00f6schen' : 'Delete entry' },
        ]} />

        <ToolGroup title={isDE ? 'Handbuch' : 'Manual'} tools={[
          { name: 'manual_save', desc: isDE ? 'Projekthandbuch speichern/aktualisieren (Markdown)' : 'Save/update project manual (Markdown)' },
          { name: 'manual_get', desc: isDE ? 'Projekthandbuch abrufen' : 'Get project manual' },
        ]} />

        <ToolGroup title={isDE ? 'Recherche' : 'Research'} tools={[
          { name: 'research_save', desc: isDE ? 'Recherche-Eintrag speichern (Quellen, Erkenntnisse)' : 'Save research entry (sources, findings)' },
          { name: 'research_search', desc: isDE ? 'Volltextsuche in Recherche-Eintr\u00e4gen' : 'Full-text search in research entries' },
          { name: 'research_list', desc: isDE ? 'Eintr\u00e4ge eines Projekts auflisten' : 'List entries for a project' },
          { name: 'research_get', desc: isDE ? 'Einzelnen Eintrag abrufen' : 'Get single entry' },
          { name: 'research_update', desc: isDE ? 'Eintrag aktualisieren' : 'Update entry' },
          { name: 'research_delete', desc: isDE ? 'Eintrag l\u00f6schen' : 'Delete entry' },
        ]} />

        <ToolGroup title={isDE ? 'Umgebungen & Secrets' : 'Environments & Secrets'} tools={[
          { name: 'environment_create', desc: isDE ? 'Umgebung anlegen (dev, staging, prod) mit Variablen' : 'Create environment (dev, staging, prod) with variables' },
          { name: 'environment_list', desc: isDE ? 'Umgebungen eines Projekts auflisten' : 'List environments for a project' },
          { name: 'environment_get', desc: isDE ? 'Einzelne Umgebung mit Variablen' : 'Get single environment with variables' },
          { name: 'environment_update', desc: isDE ? 'Umgebung aktualisieren' : 'Update environment' },
          { name: 'environment_delete', desc: isDE ? 'Umgebung l\u00f6schen' : 'Delete environment' },
          { name: 'environment_export', desc: isDE ? 'Variablen + Secrets als .env exportieren' : 'Export variables + secrets as .env' },
          { name: 'secret_set', desc: isDE ? 'Secret anlegen/aktualisieren (AES-256-GCM)' : 'Create/update secret (AES-256-GCM)' },
          { name: 'secret_get', desc: isDE ? 'Secret entschl\u00fcsselt abrufen' : 'Get decrypted secret' },
          { name: 'secret_list', desc: isDE ? 'Secrets auflisten (nur Keys, keine Werte)' : 'List secrets (keys only, no values)' },
          { name: 'secret_delete', desc: isDE ? 'Secret l\u00f6schen' : 'Delete secret' },
        ]} />

        <ToolGroup title={isDE ? 'Sonstiges' : 'Other'} tools={[
          { name: 'notify_user', desc: isDE ? 'Benachrichtigung an den User senden' : 'Send notification to user' },
          { name: 'system_instructions_get', desc: isDE ? 'Globale Agent-Instruktionen abrufen' : 'Get global agent instructions' },
          { name: 'system_instructions_set', desc: isDE ? 'Globale Agent-Instruktionen setzen' : 'Set global agent instructions' },
        ]} />
      </Section>
    </>
  );
}

function ApiSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title="REST API">
        <p className="text-gray-400 text-sm mb-4">
          {isDE ? (
            <>
              Das Backend stellt eine REST API unter <Mono>/api</Mono> bereit.
              Bei aktivierter Auth ben&ouml;tigen alle Endpunkte (au&szlig;er <Mono>/api/auth/*</Mono>) einen
              g&uuml;ltigen JWT Bearer Token. Endpunkte mit <span className="text-purple-400">(Admin)</span> erfordern die Admin-Rolle.
            </>
          ) : (
            <>
              The backend provides a REST API under <Mono>/api</Mono>.
              With auth enabled, all endpoints (except <Mono>/api/auth/*</Mono>) require a
              valid JWT bearer token. Endpoints marked <span className="text-purple-400">(Admin)</span> require the admin role.
            </>
          )}
        </p>
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="pb-2 pr-4">{isDE ? 'Methode' : 'Method'}</th>
                <th className="pb-2 pr-4">{isDE ? 'Endpunkt' : 'Endpoint'}</th>
                <th className="pb-2">{isDE ? 'Beschreibung' : 'Description'}</th>
              </tr>
            </thead>
            <tbody className="text-gray-400">
              <EndpointGroup label={isDE ? 'Auth & Benutzer' : 'Auth & Users'} endpoints={[
                { method: 'POST', path: '/api/auth/login', desc: isDE ? 'Login (Username + Password)' : 'Login (username + password)' },
                { method: 'POST', path: '/api/auth/refresh', desc: isDE ? 'Token erneuern' : 'Refresh token' },
                { method: 'POST', path: '/api/auth/logout', desc: isDE ? 'Logout (Refresh Token l\u00f6schen)' : 'Logout (delete refresh token)' },
                { method: 'GET', path: '/api/auth/status', desc: isDE ? 'Auth-Status pr\u00fcfen' : 'Check auth status' },
                { method: 'GET', path: '/api/auth/profile', desc: isDE ? 'Eigenes Profil abrufen' : 'Get own profile' },
                { method: 'PATCH', path: '/api/auth/profile', desc: isDE ? 'Profil aktualisieren (Username, E-Mail)' : 'Update profile (username, email)' },
                { method: 'POST', path: '/api/auth/change-password', desc: isDE ? 'Passwort \u00e4ndern' : 'Change password' },
                { method: 'GET', path: '/api/users', desc: isDE ? 'Alle Benutzer (Admin)' : 'All users (Admin)' },
                { method: 'POST', path: '/api/users', desc: isDE ? 'Benutzer anlegen (Admin)' : 'Create user (Admin)' },
                { method: 'PATCH', path: '/api/users/:id', desc: isDE ? 'Benutzer bearbeiten (Admin)' : 'Edit user (Admin)' },
                { method: 'DELETE', path: '/api/users/:id', desc: isDE ? 'Benutzer l\u00f6schen (Admin)' : 'Delete user (Admin)' },
              ]} />
              <EndpointGroup label="API Keys" endpoints={[
                { method: 'GET', path: '/api/api-keys', desc: isDE ? 'Eigene API Keys auflisten' : 'List own API keys' },
                { method: 'POST', path: '/api/api-keys', desc: isDE ? 'Neuen API Key erstellen (Plaintext einmalig in Response)' : 'Create new API key (plaintext shown once in response)' },
                { method: 'DELETE', path: '/api/api-keys/:id', desc: isDE ? 'API Key widerrufen' : 'Revoke API key' },
              ]} />
              <EndpointGroup label={isDE ? 'Projekte' : 'Projects'} endpoints={[
                { method: 'GET', path: '/api/projects?active=&favorite=', desc: isDE ? 'Projekte auflisten (Filter)' : 'List projects (filter)' },
                { method: 'POST', path: '/api/projects', desc: isDE ? 'Projekt anlegen' : 'Create project' },
                { method: 'GET', path: '/api/projects/:id', desc: isDE ? 'Einzelnes Projekt' : 'Single project' },
                { method: 'PUT', path: '/api/projects/:id', desc: isDE ? 'Projekt aktualisieren' : 'Update project' },
                { method: 'DELETE', path: '/api/projects/:id', desc: isDE ? 'Projekt l\u00f6schen' : 'Delete project' },
              ]} />
              <EndpointGroup label="Todos" endpoints={[
                { method: 'GET', path: '/api/todos?projectId=&status=', desc: isDE ? 'Todos filtern (Status kommasepariert)' : 'Filter todos (status comma-separated)' },
                { method: 'POST', path: '/api/todos', desc: isDE ? 'Todo anlegen' : 'Create todo' },
                { method: 'GET', path: '/api/todos/:id', desc: isDE ? 'Einzelnes Todo' : 'Single todo' },
                { method: 'PUT', path: '/api/todos/:id', desc: isDE ? 'Todo aktualisieren' : 'Update todo' },
                { method: 'DELETE', path: '/api/todos/:id', desc: isDE ? 'Todo l\u00f6schen' : 'Delete todo' },
                { method: 'POST', path: '/api/todos/:id/comments', desc: isDE ? 'Kommentar hinzuf\u00fcgen' : 'Add comment' },
              ]} />
              <EndpointGroup label="Milestones" endpoints={[
                { method: 'GET', path: '/api/milestones?projectId=', desc: isDE ? 'Milestones auflisten' : 'List milestones' },
                { method: 'POST', path: '/api/milestones', desc: isDE ? 'Milestone anlegen' : 'Create milestone' },
                { method: 'GET', path: '/api/milestones/:id', desc: isDE ? 'Einzelner Milestone' : 'Single milestone' },
                { method: 'PUT', path: '/api/milestones/:id', desc: isDE ? 'Milestone aktualisieren' : 'Update milestone' },
                { method: 'DELETE', path: '/api/milestones/:id', desc: isDE ? 'Milestone l\u00f6schen' : 'Delete milestone' },
              ]} />
              <EndpointGroup label="Sessions" endpoints={[
                { method: 'GET', path: '/api/sessions?projectId=', desc: isDE ? 'Sessions abrufen' : 'Get sessions' },
                { method: 'GET', path: '/api/sessions/latest/:projectId', desc: isDE ? 'Letzte Session' : 'Latest session' },
                { method: 'POST', path: '/api/sessions', desc: isDE ? 'Session speichern' : 'Save session' },
              ]} />
              <EndpointGroup label={isDE ? 'Wissen' : 'Knowledge'} endpoints={[
                { method: 'GET', path: '/api/knowledge?projectId=', desc: isDE ? 'Wissen abrufen' : 'Get knowledge' },
                { method: 'GET', path: '/api/knowledge/search?q=&projectId=', desc: isDE ? 'Wissen suchen' : 'Search knowledge' },
                { method: 'POST', path: '/api/knowledge', desc: isDE ? 'Wissen speichern' : 'Save knowledge' },
                { method: 'PUT', path: '/api/knowledge/:id', desc: isDE ? 'Wissen aktualisieren' : 'Update knowledge' },
                { method: 'DELETE', path: '/api/knowledge/:id', desc: isDE ? 'Wissen l\u00f6schen' : 'Delete knowledge' },
              ]} />
              <EndpointGroup label="Changelog" endpoints={[
                { method: 'GET', path: '/api/changelog?projectId=', desc: isDE ? 'Changelog auflisten' : 'List changelog' },
                { method: 'POST', path: '/api/changelog', desc: isDE ? 'Eintrag anlegen' : 'Create entry' },
                { method: 'DELETE', path: '/api/changelog/:id', desc: isDE ? 'Eintrag l\u00f6schen' : 'Delete entry' },
              ]} />
              <EndpointGroup label={isDE ? 'Umgebungen & Secrets' : 'Environments & Secrets'} endpoints={[
                { method: 'GET', path: '/api/environments?projectId=', desc: isDE ? 'Umgebungen auflisten' : 'List environments' },
                { method: 'POST', path: '/api/environments', desc: isDE ? 'Umgebung anlegen' : 'Create environment' },
                { method: 'GET', path: '/api/environments/:id', desc: isDE ? 'Einzelne Umgebung' : 'Single environment' },
                { method: 'PUT', path: '/api/environments/:id', desc: isDE ? 'Umgebung aktualisieren' : 'Update environment' },
                { method: 'DELETE', path: '/api/environments/:id', desc: isDE ? 'Umgebung l\u00f6schen' : 'Delete environment' },
                { method: 'GET', path: '/api/secrets?projectId=&environmentId=', desc: isDE ? 'Secrets (ohne Werte)' : 'Secrets (without values)' },
                { method: 'POST', path: '/api/secrets', desc: isDE ? 'Secret anlegen' : 'Create secret' },
                { method: 'GET', path: '/api/secrets/:id', desc: isDE ? 'Secret entschl\u00fcsselt' : 'Decrypted secret' },
                { method: 'PUT', path: '/api/secrets/:id', desc: isDE ? 'Secret aktualisieren' : 'Update secret' },
                { method: 'DELETE', path: '/api/secrets/:id', desc: isDE ? 'Secret l\u00f6schen' : 'Delete secret' },
              ]} />
              <EndpointGroup label={isDE ? 'Sonstiges' : 'Other'} endpoints={[
                { method: 'GET', path: '/api/search?q=&projectId=&limit=', desc: isDE ? 'Globale Suche' : 'Global search' },
                { method: 'GET', path: '/api/activities?projectId=', desc: isDE ? 'Aktivit\u00e4ten' : 'Activities' },
                { method: 'GET', path: '/api/notifications', desc: isDE ? 'Benachrichtigungen' : 'Notifications' },
                { method: 'GET', path: '/api/events/:projectId', desc: isDE ? 'SSE Live-Updates' : 'SSE live updates' },
                { method: 'GET', path: '/api/settings/:key', desc: isDE ? 'Einstellung lesen' : 'Read setting' },
                { method: 'PUT', path: '/api/settings/:key', desc: isDE ? 'Einstellung setzen' : 'Set setting' },
              ]} />
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function ArchitectureSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Architektur' : 'Architecture'}>
        <Code>{`\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510     stdio      \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502 Claude (lokal)\u2502\u25c4\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u25ba\u2502  mcp-server.ts (stdio entry)    \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518                \u2502         \u2502                        \u2502
                                \u2502         \u25bc                        \u2502
\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510  HTTP/SSE      \u2502  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510                \u2502
\u2502Claude (remote)\u2502\u25c4\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u25ba\u2502  \u2502  mcp-tools  \u2502  (shared)     \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518  /sse + /mcp   \u2502  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2518                \u2502
                                \u2502         \u25bc                        \u2502
\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510   REST /api    \u2502  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510  \u2502  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502 React Frontend\u2502\u25c4\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u25ba\u2502  \u2502 Controller\u2502\u2500\u2500\u25ba\u2502  Services \u2502\u2500\u2500\u2500\u2500\u25ba\u2502 MongoDB \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518   via nginx    \u2502  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518  \u2502  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
                                \u2502                                 \u2502
                                \u2502         NestJS Backend           \u2502
                                \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`}</Code>
      </Section>

      <Section title={isDE ? 'Module' : 'Modules'}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <ModuleItem name="projects" desc={isDE ? 'Projektverwaltung' : 'Project management'} />
          <ModuleItem name="todos" desc={isDE ? 'Tasks mit Status-Workflow' : 'Tasks with status workflow'} />
          <ModuleItem name="milestones" desc={isDE ? 'Feature-Milestones/Epics' : 'Feature milestones/epics'} />
          <ModuleItem name="sessions" desc={isDE ? 'Arbeitssitzungen' : 'Work sessions'} />
          <ModuleItem name="knowledge" desc={isDE ? 'Wissensbasis' : 'Knowledge base'} />
          <ModuleItem name="changelog" desc={isDE ? 'Versions-Changelog' : 'Version changelog'} />
          <ModuleItem name="environments" desc={isDE ? 'Umgebungsvariablen' : 'Environment variables'} />
          <ModuleItem name="secrets" desc={isDE ? 'Verschl\u00fcsselte Secrets' : 'Encrypted secrets'} />
          <ModuleItem name="auth" desc="JWT Auth + RBAC + User CRUD" />
          <ModuleItem name="api-keys" desc="API Key Auth (SHA-256)" />
          <ModuleItem name="search" desc={isDE ? 'Globale Suche' : 'Global search'} />
          <ModuleItem name="activities" desc="Activity Feed" />
          <ModuleItem name="notifications" desc={isDE ? 'In-App Benachrichtigungen' : 'In-app notifications'} />
          <ModuleItem name="push" desc="Web Push (VAPID)" />
          <ModuleItem name="events" desc={isDE ? 'SSE Live-Updates' : 'SSE live updates'} />
          <ModuleItem name="settings" desc={isDE ? 'Key-Value Einstellungen' : 'Key-value settings'} />
          <ModuleItem name="common" desc="Shared Pipes, EncryptionService" />
        </div>
      </Section>

      <Section title={isDE ? 'Technologie-Stack' : 'Technology Stack'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Backend" value="NestJS, Mongoose, MongoDB (Replica Set)" />
          <InfoRow label="Frontend" value="React, Vite, TailwindCSS" />
          <InfoRow label="MCP" value="@modelcontextprotocol/sdk (stdio + HTTP/SSE)" />
          <InfoRow label="Auth" value={isDE ? 'Passport JWT, bcrypt, Token-Rotation' : 'Passport JWT, bcrypt, token rotation'} />
          <InfoRow label={isDE ? 'Verschl\u00fcsselung' : 'Encryption'} value="AES-256-GCM (Node.js crypto)" />
          <InfoRow label={isDE ? 'Infrastruktur' : 'Infrastructure'} value="Docker Compose (MongoDB, Backend, nginx)" />
          <InfoRow label={isDE ? 'Live-Updates' : 'Live Updates'} value="MongoDB Change Streams + SSE" />
        </div>
      </Section>
    </>
  );
}

/* ─── Shared Components ─── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-cyan-400 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-medium text-gray-300 mb-2">
        <span className="text-cyan-400 mr-2">{n}.</span>
        {title}
      </h3>
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 overflow-x-auto">
      <code>{children}</code>
    </pre>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded text-xs">{children}</code>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-yellow-900/20 border border-yellow-800/50 rounded-lg p-4 mt-4">
      <p className="text-yellow-400 text-sm">{children}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-gray-300 shrink-0 w-36">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function EnvVar({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="flex gap-2">
      <code className="text-yellow-400 shrink-0">{name}</code>
      <span className="text-gray-600">{desc}</span>
    </div>
  );
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
      <p className="text-sm font-medium text-gray-200 mb-1">{title}</p>
      <p className="text-xs text-gray-500">{desc}</p>
    </div>
  );
}

function ModuleItem({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="flex gap-2 items-baseline">
      <code className="text-green-400 text-xs">{name}/</code>
      <span className="text-gray-500 text-xs">{desc}</span>
    </div>
  );
}

function ToolGroup({ title, tools }: { title: string; tools: { name: string; desc: string }[] }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-medium text-gray-300 mb-2">{title}</h3>
      <div className="space-y-1">
        {tools.map((t) => (
          <div key={t.name} className="flex gap-3 text-sm">
            <code className="text-green-400 shrink-0 w-44">{t.name}</code>
            <span className="text-gray-500">{t.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EndpointGroup({ label, endpoints }: { label: string; endpoints: { method: string; path: string; desc: string }[] }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="pt-4 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">{label}</td>
      </tr>
      {endpoints.map((ep) => (
        <Endpoint key={`${ep.method}-${ep.path}`} {...ep} />
      ))}
    </>
  );
}

function Endpoint({ method, path, desc }: { method: string; path: string; desc: string }) {
  const color = method === 'GET' ? 'text-green-400' : method === 'POST' ? 'text-blue-400' : method === 'PUT' || method === 'PATCH' ? 'text-yellow-400' : 'text-red-400';
  return (
    <tr className="border-b border-gray-800/50">
      <td className={`py-1.5 pr-4 font-mono text-xs ${color}`}>{method}</td>
      <td className="py-1.5 pr-4 font-mono text-xs text-gray-300">{path}</td>
      <td className="py-1.5 text-gray-500">{desc}</td>
    </tr>
  );
}
