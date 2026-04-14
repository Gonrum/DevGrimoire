import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

type DocsSection = 'overview' | 'setup' | 'auth' | 'mcp' | 'rag' | 'chat' | 'replication' | 'api' | 'logs' | 'git' | 'architecture';

export default function Docs() {
  const [active, setActive] = useState<DocsSection>('overview');
  const { t } = useTranslation();

  const sections: { key: DocsSection; label: string }[] = [
    { key: 'overview', label: t('docs.navOverview') },
    { key: 'setup', label: t('docs.navSetup') },
    { key: 'auth', label: t('docs.navAuth') },
    { key: 'mcp', label: t('docs.navMcp') },
    { key: 'rag', label: 'RAG' },
    { key: 'chat', label: 'Chat' },
    { key: 'replication', label: t('docs.navReplication') },
    { key: 'api', label: t('docs.navApi') },
    { key: 'logs', label: 'Logs' },
    { key: 'git', label: 'Git Integration' },
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
        {active === 'rag' && <RagSection />}
        {active === 'chat' && <ChatSection />}
        {active === 'replication' && <ReplicationDocsSection />}
        {active === 'api' && <ApiSection />}
        {active === 'logs' && <LogsSection />}
        {active === 'git' && <GitIntegrationSection />}
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
          <FeatureCard
            title={isDE ? 'Projekt-Chat' : 'Project Chat'}
            desc={isDE ? 'In-App-Chat mit konfigurierbarem LLM (LM Studio, OpenAI, Anthropic). Tool-Calling, Datei- und Bildanhänge.' : 'In-app chat with configurable LLM (LM Studio, OpenAI, Anthropic). Tool calling, file and image attachments.'}
          />
          <FeatureCard
            title={isDE ? 'Verteilte Synchronisation' : 'Distributed Sync'}
            desc={isDE ? 'Master/Slave oder bidirektionaler Peer-Mode mit Last-Write-Wins. Per-Projekt opt-in.' : 'Master/Slave or bidirectional peer mode with last-write-wins. Per-project opt-in.'}
          />
          <FeatureCard
            title={isDE ? 'RAG (Semantische Suche)' : 'RAG (Semantic Search)'}
            desc={isDE ? 'LanceDB Vektor-DB + Ollama/LM Studio Embeddings. Findet Treffer nach Bedeutung, nicht nur Stichwort.' : 'LanceDB vector DB + Ollama/LM Studio embeddings. Finds results by meaning, not just keyword.'}
          />
          <FeatureCard
            title={isDE ? 'Dateianhänge' : 'File Attachments'}
            desc={isDE ? 'MinIO/S3-Speicher, automatische Textextraktion (inkl. PDF) für RAG-Indexing.' : 'MinIO/S3 storage, automatic text extraction (incl. PDF) for RAG indexing.'}
          />
          <FeatureCard
            title="Releases"
            desc={isDE ? 'Versions-Tracking pro Projekt mit Assets, GitLab-Sync, Status-Workflow.' : 'Per-project version tracking with assets, GitLab sync, status workflow.'}
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
      <Section title={isDE ? 'MCP-Tools (109)' : 'MCP Tools (109)'}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE
            ? 'Nach dem Anbinden stehen Claude 109 Tools zur Verf\u00fcgung, gruppiert nach Entit\u00e4t. List-Tools liefern kompakte \u00dcbersichten (nur Metadaten), Details holst du \u00fcber _get-Tools \u2014 das schont den Context.'
            : 'After connecting, Claude has access to 109 tools, grouped by entity. List tools return compact overviews (metadata only), details fetched via _get tools \u2014 this keeps the context lean.'}
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
          { name: 'manual_create', desc: isDE ? 'Handbuch-Eintrag anlegen (Titel, Markdown, Kategorie)' : 'Create manual entry (title, Markdown, category)' },
          { name: 'manual_list', desc: isDE ? 'Eintr\u00e4ge eines Projekts auflisten (mit Filter nach Kategorie)' : 'List entries for a project (filterable by category)' },
          { name: 'manual_get', desc: isDE ? 'Einzelnen Eintrag mit vollem Inhalt' : 'Get single entry with full content' },
          { name: 'manual_update', desc: isDE ? 'Eintrag aktualisieren' : 'Update entry' },
          { name: 'manual_delete', desc: isDE ? 'Eintrag l\u00f6schen' : 'Delete entry' },
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

        <ToolGroup title={isDE ? 'Schemas (DB-Dokumentation)' : 'Schemas (DB Documentation)'} tools={[
          { name: 'schema_create', desc: isDE ? 'DB-Schema anlegen (Tabelle/Collection mit Feldern, Indizes)' : 'Create DB schema (table/collection with fields, indexes)' },
          { name: 'schema_list', desc: isDE ? 'Schemas eines Projekts auflisten (Filter: dbType, tags)' : 'List schemas for a project (filter: dbType, tags)' },
          { name: 'schema_get', desc: isDE ? 'Vollst\u00e4ndiges Schema mit Feldern und Indizes' : 'Full schema with fields and indexes' },
          { name: 'schema_update', desc: isDE ? 'Aktualisieren \u2014 erstellt automatisch Versions-Snapshot' : 'Update \u2014 auto-creates version snapshot' },
          { name: 'schema_delete', desc: isDE ? 'Schema und alle Versionen l\u00f6schen' : 'Delete schema and all versions' },
          { name: 'schema_versions', desc: isDE ? 'Versionshistorie eines Schemas' : 'Version history of a schema' },
        ]} />

        <ToolGroup title={isDE ? 'Features' : 'Features'} tools={[
          { name: 'feature_create', desc: isDE ? 'Feature/Funktion anlegen (Status, Priorit\u00e4t, Version)' : 'Create feature (status, priority, version)' },
          { name: 'feature_list', desc: isDE ? 'Features filtern nach Status/Kategorie' : 'Filter features by status/category' },
          { name: 'feature_get', desc: isDE ? 'Einzelnes Feature mit Details' : 'Single feature with details' },
          { name: 'feature_update', desc: isDE ? 'Feature aktualisieren (Status, Version)' : 'Update feature (status, version)' },
          { name: 'feature_delete', desc: isDE ? 'Feature l\u00f6schen' : 'Delete feature' },
        ]} />

        <ToolGroup title="Snippets" tools={[
          { name: 'snippet_save', desc: isDE ? 'Code-Snippet speichern (Sprache, Kategorie, Tags)' : 'Save code snippet (language, category, tags)' },
          { name: 'snippet_list', desc: isDE ? 'Snippets filtern' : 'Filter snippets' },
          { name: 'snippet_get', desc: isDE ? 'Snippet mit vollem Code' : 'Snippet with full code' },
          { name: 'snippet_update', desc: isDE ? 'Snippet aktualisieren' : 'Update snippet' },
          { name: 'snippet_delete', desc: isDE ? 'Snippet l\u00f6schen' : 'Delete snippet' },
          { name: 'snippet_search', desc: isDE ? 'Volltextsuche \u00fcber Snippets' : 'Full-text search across snippets' },
        ]} />

        <ToolGroup title={isDE ? 'Abh\u00e4ngigkeiten' : 'Dependencies'} tools={[
          { name: 'dependency_add', desc: isDE ? 'Einzelne Abh\u00e4ngigkeit anlegen (npm/composer/pip/cargo/go/maven/nuget/gem)' : 'Add single dependency (npm/composer/pip/cargo/go/maven/nuget/gem)' },
          { name: 'dependency_list', desc: isDE ? 'Abh\u00e4ngigkeiten auflisten' : 'List dependencies' },
          { name: 'dependency_get', desc: isDE ? 'Einzelne Abh\u00e4ngigkeit' : 'Single dependency' },
          { name: 'dependency_update', desc: isDE ? 'Abh\u00e4ngigkeit aktualisieren' : 'Update dependency' },
          { name: 'dependency_delete', desc: isDE ? 'Abh\u00e4ngigkeit l\u00f6schen' : 'Delete dependency' },
          { name: 'dependency_scan', desc: isDE ? 'Bulk-Import aus package.json/composer.json/etc.' : 'Bulk import from package.json/composer.json/etc.' },
        ]} />

        <ToolGroup title={isDE ? 'Releases' : 'Releases'} tools={[
          { name: 'release_create', desc: isDE ? 'Release anlegen (Version, Beschreibung, Plattform, Status)' : 'Create release (version, description, platform, status)' },
          { name: 'release_list', desc: isDE ? 'Releases filtern' : 'Filter releases' },
          { name: 'release_get', desc: isDE ? 'Release mit Assets' : 'Release with assets' },
          { name: 'release_update', desc: isDE ? 'Release aktualisieren' : 'Update release' },
          { name: 'release_delete', desc: isDE ? 'Release l\u00f6schen' : 'Delete release' },
          { name: 'release_sync_gitlab', desc: isDE ? 'Releases aus GitLab-Repo synchronisieren (inkl. Assets)' : 'Sync releases from GitLab repo (incl. assets)' },
        ]} />

        <ToolGroup title={isDE ? 'Anh\u00e4nge' : 'Attachments'} tools={[
          { name: 'attachment_upload', desc: isDE ? 'Datei hochladen (base64), optional an Todo/Entity geh\u00e4ngt' : 'Upload file (base64), optionally attached to todo/entity' },
          { name: 'attachment_list', desc: isDE ? 'Anh\u00e4nge auflisten (Filter: entityType, entityId)' : 'List attachments (filter: entityType, entityId)' },
          { name: 'attachment_get', desc: isDE ? 'Metadaten einer Datei' : 'File metadata' },
          { name: 'attachment_download', desc: isDE ? 'Dateiinhalt laden (Text plain, bin\u00e4r base64)' : 'Load file content (text plain, binary base64)' },
          { name: 'attachment_delete', desc: isDE ? 'Datei l\u00f6schen (Storage + DB)' : 'Delete file (storage + DB)' },
        ]} />

        <ToolGroup title={isDE ? 'Wiederkehrende Tasks' : 'Recurring Tasks'} tools={[
          { name: 'recurring_task_create', desc: isDE ? 'Wiederkehrenden Task planen (Cron oder Intervall)' : 'Schedule recurring task (cron or interval)' },
          { name: 'recurring_task_list', desc: isDE ? 'Geplante Tasks auflisten' : 'List scheduled tasks' },
          { name: 'recurring_task_get', desc: isDE ? 'Einzelnen Plan abrufen' : 'Get single schedule' },
          { name: 'recurring_task_update', desc: isDE ? 'Plan aktualisieren' : 'Update schedule' },
          { name: 'recurring_task_delete', desc: isDE ? 'Plan l\u00f6schen' : 'Delete schedule' },
        ]} />

        <ToolGroup title="Commits" tools={[
          { name: 'commit_list', desc: isDE ? 'Git-Commits eines Projekts (Filter: branch, author, date)' : 'Git commits for a project (filter: branch, author, date)' },
          { name: 'commit_search', desc: isDE ? 'Suche in Commit-Messages' : 'Search in commit messages' },
          { name: 'commit_sync', desc: isDE ? 'Manueller Sync mit GitHub/GitLab' : 'Manual sync with GitHub/GitLab' },
        ]} />

        <ToolGroup title={isDE ? 'Logs' : 'Logs'} tools={[
          { name: 'log_list', desc: isDE ? 'Per-Projekt Log-Eintr\u00e4ge (Filter: level, service, search)' : 'Per-project log entries (filter: level, service, search)' },
          { name: 'log_search', desc: isDE ? 'Volltextsuche in Logs' : 'Full-text search in logs' },
          { name: 'log_stats', desc: isDE ? 'Aggregierte Statistik (count by level, service, time)' : 'Aggregated stats (count by level, service, time)' },
        ]} />

        <ToolGroup title={isDE ? 'Souls (Projekt-Pers\u00f6nlichkeit)' : 'Souls (Project Personality)'} tools={[
          { name: 'soul_get', desc: isDE ? 'Projekt-Soul abrufen (Pers\u00f6nlichkeit, Stimme, Prinzipien)' : 'Get project soul (personality, voice, principles)' },
          { name: 'soul_update', desc: isDE ? 'Projekt-Soul aktualisieren' : 'Update project soul' },
        ]} />

        <ToolGroup title="RAG" tools={[
          { name: 'rag_search', desc: isDE ? 'Semantische Suche \u00fcber alle indizierten Eintr\u00e4ge' : 'Semantic search across all indexed entries' },
          { name: 'rag_reindex', desc: isDE ? 'Vektor-Index neu aufbauen (alle/ein Projekt)' : 'Rebuild vector index (all/single project)' },
          { name: 'rag_status', desc: isDE ? 'Index-Statistik, aktiver Embedding-Endpoint' : 'Index stats, active embedding endpoint' },
        ]} />

        <ToolGroup title={isDE ? 'Dialog' : 'Dialog'} tools={[
          { name: 'notify_user', desc: isDE ? 'Push-Notification an den User senden' : 'Send push notification to user' },
          { name: 'ask_user', desc: isDE ? 'Interaktive Frage stellen (yes/no/text), wartet auf Antwort' : 'Ask interactive question (yes/no/text), waits for reply' },
        ]} />

        <ToolGroup title={isDE ? 'Sonstiges' : 'Other'} tools={[
          { name: 'system_instructions_get', desc: isDE ? 'Globale + projekt-spezifische Agent-Instruktionen abrufen' : 'Get global + project-specific agent instructions' },
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
              <EndpointGroup label="Logs" endpoints={[
                { method: 'POST', path: '/api/logs', desc: isDE ? 'Log-Eintrag erstellen (via API Key)' : 'Create log entry (via API key)' },
                { method: 'POST', path: '/api/logs/batch', desc: isDE ? 'Mehrere Logs auf einmal senden' : 'Send multiple logs at once' },
                { method: 'GET', path: '/api/logs?projectId=&level=&service=&search=', desc: isDE ? 'Logs abrufen (mit Filtern)' : 'Fetch logs (with filters)' },
                { method: 'GET', path: '/api/logs/stats?projectId=', desc: isDE ? 'Log-Statistiken' : 'Log statistics' },
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

function LogsSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-sm text-gray-400 leading-relaxed">
          {isDE
            ? 'Externe Anwendungen können Logs per REST API an DevGrimoire senden. Logs werden pro Projekt gespeichert und nach 5 Tagen automatisch gelöscht (MongoDB TTL Index). Claude kann über MCP Tools auf die Logs zugreifen.'
            : 'External applications can send logs to DevGrimoire via the REST API. Logs are stored per project and automatically deleted after 5 days (MongoDB TTL index). Claude can access logs via MCP tools.'}
        </p>
        <div className="mt-3 space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Aufbewahrung' : 'Retention'} value={isDE ? '5 Tage (konfigurierbar via LOG_TTL_DAYS)' : '5 days (configurable via LOG_TTL_DAYS)'} />
          <InfoRow label={isDE ? 'Authentifizierung' : 'Authentication'} value={isDE ? 'API Key (Authorization: Bearer cv_...)' : 'API key (Authorization: Bearer cv_...)'} />
          <InfoRow label="MCP Tools" value="log_list, log_search, log_stats" />
          <InfoRow label={isDE ? 'Frontend' : 'Frontend'} value={isDE ? 'Projekt → System → Orakel' : 'Project → System → Oracles'} />
        </div>
      </Section>

      <Section title={isDE ? 'Einrichtung' : 'Setup'}>
        <Step n={1} title={isDE ? 'API Key erstellen' : 'Create API Key'}>
          <p className="text-sm text-gray-400">
            {isDE
              ? 'Unter Einstellungen → API Keys einen neuen Key erstellen. Den Plaintext-Key kopieren — er wird nur einmal angezeigt.'
              : 'Go to Settings → API Keys and create a new key. Copy the plaintext key — it is only shown once.'}
          </p>
        </Step>
        <Step n={2} title={isDE ? 'Logs senden' : 'Send Logs'}>
          <p className="text-sm text-gray-400 mb-2">
            {isDE ? 'Einzelner Log-Eintrag:' : 'Single log entry:'}
          </p>
          <Code>{`curl -X POST ${window.location.origin}/api/logs \\
  -H "Authorization: Bearer cv_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "PROJECT_ID",
    "level": "error",
    "message": "Database connection timeout",
    "service": "api-server",
    "area": "database",
    "environment": "production",
    "tags": ["db", "timeout"]
  }'`}</Code>
          <p className="text-sm text-gray-400 mt-3 mb-2">
            {isDE ? 'Mehrere Logs auf einmal (Batch):' : 'Multiple logs at once (batch):'}
          </p>
          <Code>{`curl -X POST ${window.location.origin}/api/logs/batch \\
  -H "Authorization: Bearer cv_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "logs": [
      { "projectId": "PROJECT_ID", "level": "info", "message": "Server started", "service": "api" },
      { "projectId": "PROJECT_ID", "level": "warn", "message": "Slow query", "service": "db" }
    ]
  }'`}</Code>
        </Step>
        <Step n={3} title={isDE ? 'Logs ansehen' : 'View Logs'}>
          <p className="text-sm text-gray-400">
            {isDE
              ? 'Im Projekt unter System → Orakel. Filter nach Level, Service oder Volltextsuche. Claude kann Logs auch über die MCP Tools log_list, log_search und log_stats abfragen.'
              : 'In the project under System → Oracles. Filter by level, service, or full-text search. Claude can also query logs via the MCP tools log_list, log_search, and log_stats.'}
          </p>
        </Step>
      </Section>

      <Section title={isDE ? 'Felder' : 'Fields'}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="py-2 pr-4">{isDE ? 'Feld' : 'Field'}</th>
                <th className="py-2 pr-4">{isDE ? 'Pflicht' : 'Required'}</th>
                <th className="py-2">{isDE ? 'Beschreibung' : 'Description'}</th>
              </tr>
            </thead>
            <tbody className="text-gray-400">
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>projectId</Mono></td><td className="pr-4">{isDE ? 'Ja' : 'Yes'}</td><td>{isDE ? 'Projekt MongoDB ID' : 'Project MongoDB ID'}</td></tr>
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>message</Mono></td><td className="pr-4">{isDE ? 'Ja' : 'Yes'}</td><td>{isDE ? 'Log-Nachricht' : 'Log message'}</td></tr>
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>level</Mono></td><td className="pr-4">{isDE ? 'Nein' : 'No'}</td><td>debug, info, warn, error (default: info)</td></tr>
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>service</Mono></td><td className="pr-4">{isDE ? 'Nein' : 'No'}</td><td>{isDE ? 'Service-Name (z.B. api-server, worker)' : 'Service name (e.g. api-server, worker)'}</td></tr>
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>area</Mono></td><td className="pr-4">{isDE ? 'Nein' : 'No'}</td><td>{isDE ? 'Bereich im Service (z.B. database, auth)' : 'Area within service (e.g. database, auth)'}</td></tr>
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>environment</Mono></td><td className="pr-4">{isDE ? 'Nein' : 'No'}</td><td>production, staging, development, test</td></tr>
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>metadata</Mono></td><td className="pr-4">{isDE ? 'Nein' : 'No'}</td><td>{isDE ? 'Freies JSON-Objekt für zusätzliche Daten' : 'Free-form JSON object for additional data'}</td></tr>
              <tr className="border-b border-gray-800/50"><td className="py-1.5 pr-4"><Mono>tags</Mono></td><td className="pr-4">{isDE ? 'Nein' : 'No'}</td><td>{isDE ? 'String-Array für Kategorisierung' : 'String array for categorization'}</td></tr>
              <tr><td className="py-1.5 pr-4"><Mono>source</Mono></td><td className="pr-4">{isDE ? 'Nein' : 'No'}</td><td>{isDE ? 'Quell-Identifikator (z.B. Hostname)' : 'Source identifier (e.g. hostname)'}</td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={isDE ? 'Konfiguration' : 'Configuration'}>
        <p className="text-sm text-gray-400 mb-2">
          {isDE ? 'Optionale Umgebungsvariable in der .env:' : 'Optional environment variable in .env:'}
        </p>
        <Code>{`# Log-Aufbewahrungszeit in Tagen (default: 5)
LOG_TTL_DAYS=5`}</Code>
      </Section>
    </>
  );
}

function GitIntegrationSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-sm text-gray-400 leading-relaxed">
          {isDE
            ? 'DevGrimoire kann Commits aus GitHub- und GitLab-Repositories automatisch synchronisieren. Pro Projekt können mehrere Repositories angebunden werden. Tokens werden verschlüsselt gespeichert (AES-256-GCM).'
            : 'DevGrimoire can automatically sync commits from GitHub and GitLab repositories. Multiple repositories can be connected per project. Tokens are stored encrypted (AES-256-GCM).'}
        </p>
      </Section>

      <Section title={isDE ? 'Repository verbinden' : 'Connect Repository'}>
        <Step n={1} title={isDE ? 'Projekt-Einstellungen öffnen' : 'Open project settings'}>
          <p className="text-sm text-gray-400">{isDE ? 'Klicke auf "Settings" im Projekt-Header.' : 'Click "Settings" in the project header.'}</p>
        </Step>
        <Step n={2} title={isDE ? 'Zum Abschnitt "Git Repositories" scrollen' : 'Scroll to "Git Repositories" section'}>
          <p className="text-sm text-gray-400">{isDE ? 'Klicke auf "+ Repository hinzufügen".' : 'Click "+ Repository hinzufügen" (Add repository).'}</p>
        </Step>
        <Step n={3} title={isDE ? 'Provider & URL eingeben' : 'Enter provider & URL'}>
          <p className="text-sm text-gray-400">
            {isDE ? 'Wähle GitHub oder GitLab und gib die Repository-URL ein:' : 'Choose GitHub or GitLab and enter the repository URL:'}
          </p>
          <Code>{`# GitHub
https://github.com/owner/repo

# GitLab (gitlab.com)
https://gitlab.com/group/project

# GitLab (Self-Hosted)
https://gitlab.example.com/group/project
→ Base URL: https://gitlab.example.com`}</Code>
        </Step>
        <Step n={4} title={isDE ? 'Access Token eingeben' : 'Enter access token'}>
          <div className="space-y-2 text-sm text-gray-400">
            <p><strong className="text-gray-300">GitHub:</strong> {isDE ? 'Fine-Grained PAT mit "Contents: Read" Berechtigung' : 'Fine-Grained PAT with "Contents: Read" permission'}</p>
            <p><strong className="text-gray-300">GitLab:</strong> {isDE ? 'Personal Access Token mit Scope' : 'Personal Access Token with scope'} <Mono>read_api</Mono></p>
          </div>
        </Step>
        <Step n={5} title={isDE ? 'Verbinden & Sync' : 'Connect & Sync'}>
          <p className="text-sm text-gray-400">{isDE ? 'Der Token wird validiert, verschlüsselt gespeichert und der erste Sync kann über den Commits-Tab gestartet werden.' : 'The token is validated, stored encrypted, and the first sync can be started from the Commits tab.'}</p>
        </Step>
      </Section>

      <Section title={isDE ? 'Sync-Verhalten' : 'Sync Behavior'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Erster Sync' : 'Initial sync'} value={isDE ? 'Lädt alle Commits des Default-Branches (paginiert, 100/Seite)' : 'Fetches all commits from default branch (paginated, 100/page)'} />
          <InfoRow label={isDE ? 'Folge-Syncs' : 'Incremental sync'} value={isDE ? 'Nur neue Commits seit dem letzten Sync (since-Parameter)' : 'Only new commits since last sync (since parameter)'} />
          <InfoRow label="GitHub ETag" value={isDE ? 'Conditional Requests — bei 304 kein Rate-Limit-Verbrauch' : 'Conditional requests — 304 costs zero rate limit'} />
          <InfoRow label={isDE ? 'Duplikat-Schutz' : 'Deduplication'} value={isDE ? 'Unique Index auf projectId + SHA' : 'Unique index on projectId + SHA'} />
        </div>
      </Section>

      <Section title="Rate Limits">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="py-2 pr-4">Provider</th>
              <th className="py-2 pr-4">{isDE ? 'Authentifiziert' : 'Authenticated'}</th>
              <th className="py-2">{isDE ? 'Unauthentifiziert' : 'Unauthenticated'}</th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            <tr className="border-b border-gray-800/50">
              <td className="py-2 pr-4 text-gray-300">GitHub</td>
              <td className="py-2 pr-4">5.000/h</td>
              <td className="py-2">60/h</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-2 pr-4 text-gray-300">GitLab (gitlab.com)</td>
              <td className="py-2 pr-4">7.200/h</td>
              <td className="py-2">3.600/h</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-gray-300">GitLab (Self-Hosted)</td>
              <td className="py-2 pr-4" colSpan={2}>{isDE ? 'Admin-konfigurierbar' : 'Admin-configurable'}</td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title={isDE ? 'MCP-Tools' : 'MCP Tools'}>
        <ToolGroup title="Commits" tools={[
          { name: 'commit_list', desc: isDE ? 'Commits auflisten (Filter: branch, author, since, until, provider)' : 'List commits (filter: branch, author, since, until, provider)' },
          { name: 'commit_search', desc: isDE ? 'Volltextsuche in Commit-Messages' : 'Full-text search in commit messages' },
          { name: 'commit_sync', desc: isDE ? 'Manuellen Sync triggern' : 'Trigger manual sync' },
        ]} />
      </Section>

      <Section title={isDE ? 'REST API Endpoints' : 'REST API Endpoints'}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="py-2 pr-4">Method</th>
              <th className="py-2 pr-4">Path</th>
              <th className="py-2">{isDE ? 'Beschreibung' : 'Description'}</th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            <Endpoint method="GET" path="/api/commits" desc={isDE ? 'Commits auflisten (projectId, branch, author, since, until)' : 'List commits (projectId, branch, author, since, until)'} />
            <Endpoint method="GET" path="/api/commits/search" desc={isDE ? 'Volltextsuche (q, projectId)' : 'Full-text search (q, projectId)'} />
            <Endpoint method="GET" path="/api/commits/count" desc={isDE ? 'Anzahl Commits (projectId)' : 'Commit count (projectId)'} />
            <Endpoint method="GET" path="/api/commits/:id" desc={isDE ? 'Einzelnen Commit laden' : 'Get single commit'} />
            <Endpoint method="POST" path="/api/commits/sync" desc={isDE ? 'Sync triggern (projectId, repoIndex?)' : 'Trigger sync (projectId, repoIndex?)'} />
            <Endpoint method="POST" path="/api/commits/validate-token" desc={isDE ? 'Token validieren' : 'Validate token'} />
          </tbody>
        </table>
      </Section>

      <Section title={isDE ? 'Fehlerbehebung' : 'Troubleshooting'}>
        <div className="space-y-3 text-sm">
          <div>
            <p className="text-gray-300 font-medium">{isDE ? 'Token-Validierung fehlgeschlagen' : 'Token validation failed'}</p>
            <p className="text-gray-500">{isDE ? 'Token-Berechtigungen prüfen: GitHub → Contents:Read, GitLab → read_api' : 'Check token permissions: GitHub → Contents:Read, GitLab → read_api'}</p>
          </div>
          <div>
            <p className="text-gray-300 font-medium">{isDE ? 'Keine Commits nach Sync' : 'No commits after sync'}</p>
            <p className="text-gray-500">{isDE ? 'Default Branch in den Repository-Settings prüfen (main vs master)' : 'Check default branch in repository settings (main vs master)'}</p>
          </div>
          <div>
            <p className="text-gray-300 font-medium">{isDE ? 'GitLab Self-Hosted: 404' : 'GitLab self-hosted: 404'}</p>
            <p className="text-gray-500">{isDE ? 'Base URL muss das Protokoll enthalten (https://gitlab.example.com)' : 'Base URL must include the protocol (https://gitlab.example.com)'}</p>
          </div>
        </div>
      </Section>
    </>
  );
}

function RagSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-sm text-gray-400 leading-relaxed">
          {isDE
            ? 'DevGrimoire enthält ein integriertes RAG-System (Retrieval-Augmented Generation) für semantische Suche über alle Projektdaten. Anders als Keyword-Suche versteht RAG Bedeutung — eine Suche nach "wie deploye ich das" findet auch Einträge über "Docker Compose Setup" oder "CI/CD Pipeline".'
            : 'DevGrimoire includes a built-in RAG system (Retrieval-Augmented Generation) for semantic search across all project data. Unlike keyword search, RAG understands meaning — searching for "how do I deploy" also finds entries about "Docker Compose setup" or "CI/CD pipeline".'}
        </p>
      </Section>

      <Section title={isDE ? 'Wie es funktioniert' : 'How It Works'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Vector DB" value={isDE ? 'LanceDB (embedded, kein extra Service nötig)' : 'LanceDB (embedded, no extra service needed)'} />
          <InfoRow label="Embeddings" value={isDE ? 'Ollama (CPU) oder OpenAI-kompatible API wie LM Studio (GPU)' : 'Ollama (CPU) or OpenAI-compatible API like LM Studio (GPU)'} />
          <InfoRow label={isDE ? 'Indizierte Entitäten' : 'Indexed Entities'} value="Knowledge, Research, Manuals, Changelogs, Todos, Sessions" />
          <InfoRow label="Auto-Sync" value={isDE ? 'Neue/geänderte/gelöschte Dokumente werden automatisch via Change Streams indexiert' : 'New/updated/deleted documents are automatically indexed via Change Streams'} />
          <InfoRow label="Fallback" value={isDE ? 'Automatischer Fallback von Primary (GPU) auf Secondary (CPU) wenn nicht erreichbar' : 'Automatic fallback from primary (GPU) to secondary (CPU) when unavailable'} />
        </div>
      </Section>

      <Section title="Setup">
        <Step n={1} title={isDE ? 'Embedding-Modell installieren' : 'Install embedding model'}>
          <Code>{`# Option A: Ollama (CPU)
ollama pull nomic-embed-text-v2-moe

# Option B: LM Studio (GPU)
# Load nomic-embed-text-v2-moe via LM Studio UI`}</Code>
        </Step>
        <Step n={2} title={isDE ? 'In .env konfigurieren' : 'Configure in .env'}>
          <Code>{`# Ollama (default)
RAG_EMBEDDING_PROVIDER=ollama
RAG_EMBEDDING_MODEL=nomic-embed-text

# Or: LM Studio / OpenAI-compatible (GPU)
RAG_EMBEDDING_PROVIDER=openai-compatible
RAG_EMBEDDING_URL=http://<gpu-host>:1234
RAG_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v2-moe

# Optional: automatic fallback
RAG_FALLBACK_PROVIDER=ollama
RAG_FALLBACK_URL=http://localhost:11434
RAG_FALLBACK_MODEL=nomic-embed-text-v2-moe`}</Code>
        </Step>
        <Step n={3} title={isDE ? 'Initialen Index aufbauen' : 'Build initial index'}>
          <p className="text-sm text-gray-400">
            {isDE
              ? 'Nach dem Start einmal den Index über das MCP-Tool befüllen:'
              : 'After startup, build the index once via the MCP tool:'}
          </p>
          <Code>rag_reindex</Code>
        </Step>
      </Section>

      <Section title="MCP Tools">
        <ToolGroup title="RAG" tools={[
          { name: 'rag_search', desc: isDE ? 'Semantische Suche (query, projectId?, entity?, limit?)' : 'Semantic search (query, projectId?, entity?, limit?)' },
          { name: 'rag_reindex', desc: isDE ? 'Vollen Index neu aufbauen (projectId? für einzelnes Projekt)' : 'Rebuild full index (projectId? for single project)' },
          { name: 'rag_status', desc: isDE ? 'Index-Statistiken, aktiver Endpoint, Fallback-Konfiguration' : 'Index statistics, active endpoint, fallback config' },
        ]} />
      </Section>

      <Section title={isDE ? 'RAG vs. Keyword-Suche' : 'RAG vs. Keyword Search'}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="py-2 pr-4"></th>
              <th className="py-2 pr-4"><Mono>rag_search</Mono></th>
              <th className="py-2"><Mono>knowledge_search</Mono></th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            <tr className="border-b border-gray-800/50">
              <td className="py-2 pr-4 text-gray-300">{isDE ? 'Methode' : 'Method'}</td>
              <td className="py-2 pr-4">{isDE ? 'Vektor-Ähnlichkeit' : 'Vector similarity'}</td>
              <td className="py-2">{isDE ? 'Keyword-Match' : 'Keyword match'}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-2 pr-4 text-gray-300">{isDE ? 'Entitäten' : 'Entities'}</td>
              <td className="py-2 pr-4">{isDE ? 'Alle (Knowledge, Research, Manual, Changelog, Todo, Session)' : 'All (Knowledge, Research, Manual, Changelog, Todo, Session)'}</td>
              <td className="py-2">{isDE ? 'Nur Knowledge' : 'Knowledge only'}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-2 pr-4 text-gray-300">{isDE ? 'Ideal für' : 'Best for'}</td>
              <td className="py-2 pr-4">{isDE ? 'Explorative Fragen' : 'Exploratory questions'}</td>
              <td className="py-2">{isDE ? 'Gezielte Keywords' : 'Targeted keywords'}</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-gray-300">{isDE ? 'Voraussetzung' : 'Requires'}</td>
              <td className="py-2 pr-4">Ollama / LM Studio</td>
              <td className="py-2">MongoDB</td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title={isDE ? 'Konfiguration (.env)' : 'Configuration (.env)'}>
        <div className="space-y-1">
          <EnvVar name="RAG_EMBEDDING_PROVIDER" desc={isDE ? '"ollama" oder "openai-compatible" (Default: ollama)' : '"ollama" or "openai-compatible" (default: ollama)'} />
          <EnvVar name="RAG_EMBEDDING_URL" desc={isDE ? 'URL des Embedding-Servers' : 'Embedding server URL'} />
          <EnvVar name="RAG_EMBEDDING_MODEL" desc={isDE ? 'Modellname (Default: nomic-embed-text)' : 'Model name (default: nomic-embed-text)'} />
          <EnvVar name="RAG_FALLBACK_PROVIDER" desc={isDE ? 'Fallback-Provider (optional)' : 'Fallback provider (optional)'} />
          <EnvVar name="RAG_FALLBACK_URL" desc={isDE ? 'Fallback-Server-URL (optional)' : 'Fallback server URL (optional)'} />
          <EnvVar name="RAG_FALLBACK_MODEL" desc={isDE ? 'Fallback-Modellname (optional)' : 'Fallback model name (optional)'} />
          <EnvVar name="RAG_MAX_INPUT_CHARS" desc={isDE ? 'Max. Zeichen pro Embedding (Default: 1800)' : 'Max chars per embedding (default: 1800)'} />
          <EnvVar name="OLLAMA_URL" desc={isDE ? 'Ollama-URL (Default: http://localhost:11434)' : 'Ollama URL (default: http://localhost:11434)'} />
        </div>
      </Section>

      <Hint>
        {isDE
          ? 'RAG ist optional. Wenn kein Embedding-Server verfügbar ist, startet die App normal — die RAG-Features sind dann einfach deaktiviert.'
          : 'RAG is optional. If no embedding server is available, the app starts normally — RAG features are simply disabled.'}
      </Hint>
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
          <ModuleItem name="rag" desc={isDE ? 'Semantische Suche (LanceDB + Embeddings)' : 'Semantic search (LanceDB + embeddings)'} />
          <ModuleItem name="commits" desc={isDE ? 'Git-Commit-Sync (GitHub/GitLab)' : 'Git commit sync (GitHub/GitLab)'} />
          <ModuleItem name="logs" desc={isDE ? 'Application Logs (TTL 5 Tage)' : 'Application logs (TTL 5 days)'} />
          <ModuleItem name="events" desc={isDE ? 'SSE Live-Updates' : 'SSE live updates'} />
          <ModuleItem name="settings" desc={isDE ? 'Key-Value Einstellungen' : 'Key-value settings'} />
          <ModuleItem name="common" desc="Shared Pipes, EncryptionService" />
          <ModuleItem name="chat" desc={isDE ? 'Projekt-Chat mit LLM (Multi-Provider, Tool-Calling)' : 'Project chat with LLM (multi-provider, tool calling)'} />
          <ModuleItem name="releases" desc={isDE ? 'Release-Tracking + GitLab-Sync' : 'Release tracking + GitLab sync'} />
          <ModuleItem name="attachments" desc={isDE ? 'MinIO/S3 Dateispeicher mit Textextraktion' : 'MinIO/S3 file storage with text extraction'} />
          <ModuleItem name="replication" desc={isDE ? 'Master/Slave + Peer-Mode bidirektionaler Sync' : 'Master/slave + peer-mode bidirectional sync'} />
          <ModuleItem name="recurring-tasks" desc={isDE ? 'Geplante Task-Erstellung' : 'Scheduled task creation'} />
          <ModuleItem name="souls" desc={isDE ? 'Projekt-Pers\u00f6nlichkeit' : 'Project personality'} />
          <ModuleItem name="questions" desc={isDE ? 'ask_user interaktiver Dialog' : 'ask_user interactive dialog'} />
          <ModuleItem name="minio" desc={isDE ? 'MinIO/S3 Client-Wrapper' : 'MinIO/S3 client wrapper'} />
        </div>
      </Section>

      <Section title={isDE ? 'Technologie-Stack' : 'Technology Stack'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Backend" value="NestJS, Mongoose, MongoDB (Replica Set), LanceDB" />
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

function ChatSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-gray-400 leading-relaxed">
          {isDE
            ? 'Im Dashboard rechts unten findest du das Chat-Dock — eine in-app Konversation mit einem konfigurierbaren LLM, scope auf das aktuelle Projekt. Der System-Prompt wird automatisch aus Projekt-Kontext (RAG-Treffer, History, Anhänge) gebaut. Optional kann der LLM via Tool-Calling Live-Daten lesen oder schreiben.'
            : 'The chat dock at the bottom-right of the dashboard is an in-app conversation with a configurable LLM, scoped to the current project. The system prompt is auto-built from project context (RAG hits, history, attachments). Optionally the LLM can read or write live data via tool calling.'}
        </p>
      </Section>

      <Section title={isDE ? 'Provider' : 'Providers'}>
        <p className="text-gray-400 text-sm mb-3">
          {isDE
            ? 'Pro Endpoint frei wählbar in Settings → Chat. Mehrere Endpoints werden in Reihenfolge probiert (Fallback bei Fehler).'
            : 'Per-endpoint selectable in Settings → Chat. Multiple endpoints are tried in order (fallback on error).'}
        </p>
        <div className="text-sm">
          <table className="w-full text-left border border-gray-800 rounded">
            <thead className="bg-gray-900 text-gray-300 text-xs">
              <tr>
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2">{isDE ? 'Default-URL' : 'Default URL'}</th>
                <th className="px-3 py-2">{isDE ? 'API-Key' : 'API key'}</th>
                <th className="px-3 py-2">Tool-Calling</th>
                <th className="px-3 py-2">Vision</th>
              </tr>
            </thead>
            <tbody className="text-gray-400 text-xs">
              <tr className="border-t border-gray-800">
                <td className="px-3 py-2 font-mono">lmstudio</td>
                <td className="px-3 py-2 font-mono">http://localhost:1234</td>
                <td className="px-3 py-2">{isDE ? 'optional' : 'optional'}</td>
                <td className="px-3 py-2 text-emerald-400">✓</td>
                <td className="px-3 py-2 text-gray-500">{isDE ? 'modellabhängig' : 'model-dependent'}</td>
              </tr>
              <tr className="border-t border-gray-800">
                <td className="px-3 py-2 font-mono">openai-compatible</td>
                <td className="px-3 py-2 font-mono">—</td>
                <td className="px-3 py-2">{isDE ? 'optional' : 'optional'}</td>
                <td className="px-3 py-2 text-emerald-400">✓</td>
                <td className="px-3 py-2 text-gray-500">{isDE ? 'modellabhängig' : 'model-dependent'}</td>
              </tr>
              <tr className="border-t border-gray-800">
                <td className="px-3 py-2 font-mono">anthropic</td>
                <td className="px-3 py-2 font-mono">https://api.anthropic.com</td>
                <td className="px-3 py-2 text-amber-300">{isDE ? 'Pflicht' : 'required'} (sk-ant-...)</td>
                <td className="px-3 py-2 text-gray-500">{isDE ? 'Roadmap' : 'Roadmap'}</td>
                <td className="px-3 py-2 text-emerald-400">✓</td>
              </tr>
              <tr className="border-t border-gray-800">
                <td className="px-3 py-2 font-mono">openai</td>
                <td className="px-3 py-2 font-mono">https://api.openai.com</td>
                <td className="px-3 py-2 text-amber-300">{isDE ? 'Pflicht' : 'required'} (sk-...)</td>
                <td className="px-3 py-2 text-emerald-400">✓</td>
                <td className="px-3 py-2 text-emerald-400">✓</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-gray-500 text-xs mt-3">
          {isDE
            ? 'Ollama: nutze "openai-compatible" mit URL http://localhost:11434. Der native ollama-Provider wurde entfernt (M-12), bestehende Configs migrieren automatisch. Ollama\'s /v1-Shim unterstützt seit v0.3 Function-Calling und Vision.'
            : 'Ollama: use "openai-compatible" with URL http://localhost:11434. The native ollama provider was retired (M-12); existing configs auto-migrate. Ollama\'s /v1 shim supports function calling and vision since v0.3.'}
        </p>
      </Section>

      <Section title={isDE ? 'Tool-Calling' : 'Tool Calling'}>
        <p className="text-gray-400 text-sm mb-3">
          {isDE
            ? 'Tools sind in Lese- und Schreib-Gruppen aufgeteilt, opt-in pro Tool. Default-Allowlist enthält nur einige Read-Tools (rag_search, knowledge_search, todo_list, milestone_list). Schreibende Tools müssen explizit aktiviert werden und sind in der UI rot hinterlegt mit Confirm-Dialog beim "Alle aktivieren".'
            : 'Tools are split into read and write groups, opt-in per tool. The default allowlist enables only a few read tools (rag_search, knowledge_search, todo_list, milestone_list). Write tools must be enabled explicitly, are highlighted red in the UI and require confirmation when enabling all at once.'}
        </p>
        <p className="text-gray-400 text-sm mb-3">
          {isDE
            ? 'Jeder erfolgreiche Schreib-Tool-Aufruf wird im Logs-Modul mit User, Session, Tool-Name und Args (gekürzt) festgehalten — vollständiger Audit-Trail.'
            : 'Every successful write-tool call is logged in the logs module with user, session, tool name and (truncated) args — a full audit trail.'}
        </p>
        <p className="text-gray-400 text-sm">
          {isDE
            ? 'Hartcodiert geblockt: project_delete und alle _delete-Bulk-Operationen — auch wenn sie in der Allowlist stünden.'
            : 'Hard-coded as blocked: project_delete and all _delete bulk operations — even if added to the allowlist.'}
        </p>
      </Section>

      <Section title={isDE ? 'Anhänge (Text & Bild)' : 'Attachments (Text & Image)'}>
        <p className="text-gray-400 text-sm mb-3">
          {isDE
            ? 'Im Chat-Dock kannst du via Paperclip-Button, Drag-and-Drop oder Clipboard-Paste Dateien anhängen. Textdateien (.md, .json, Code, .pdf, .csv) werden serverseitig extrahiert und in den System-Prompt eingefügt — pro Datei max 20.000 Zeichen, gesamt-Budget 80.000.'
            : 'In the chat dock you can attach files via paperclip button, drag-and-drop, or clipboard paste. Text files (.md, .json, code, .pdf, .csv) are extracted server-side and injected into the system prompt — max 20,000 chars per file, 80,000 total budget.'}
        </p>
        <p className="text-gray-400 text-sm">
          {isDE
            ? 'Bilder (JPEG/PNG/WEBP/GIF) werden provider-spezifisch encoded: Anthropic content_block, OpenAI image_url data-URL, Ollama messages[].images base64. Voraussetzung: der gewählte Endpoint hat das "Vision-Modell"-Flag aktiv und das geladene Modell ist tatsächlich vision-fähig.'
            : 'Images (JPEG/PNG/WEBP/GIF) are encoded per-provider: Anthropic content_block, OpenAI image_url data URL, Ollama messages[].images base64. Requirement: the selected endpoint has the "vision model" flag enabled and the loaded model is actually vision-capable.'}
        </p>
      </Section>

      <Section title={isDE ? 'API-Key-Sicherheit' : 'API Key Security'}>
        <ul className="text-gray-400 text-sm space-y-1 list-disc list-inside">
          <li>{isDE ? 'API-Keys werden AES-256-GCM verschlüsselt in der Settings-DB gespeichert (gleiche Mechanik wie Secrets/Replication, nutzt SECRETS_ENCRYPTION_KEY)' : 'API keys are AES-256-GCM encrypted in the settings DB (same mechanism as secrets/replication, uses SECRETS_ENCRYPTION_KEY)'}</li>
          <li>{isDE ? 'GET /api/chat/config liefert nie den Klartext-Key — stattdessen nur hasApiKey: true/false pro Endpoint' : 'GET /api/chat/config never returns the plain-text key — only hasApiKey: true/false per endpoint'}</li>
          <li>{isDE ? 'Beim PUT: leeres Feld = unverändert, expliziter "" = löschen, Wert = überschreiben' : 'On PUT: empty field = unchanged, explicit "" = delete, value = overwrite'}</li>
          <li>{isDE ? 'Ohne SECRETS_ENCRYPTION_KEY schlägt das Anlegen eines Cloud-Endpoints fehl — setze den Key vor der Konfiguration' : 'Without SECRETS_ENCRYPTION_KEY, creating a cloud endpoint fails — set the key before configuring'}</li>
        </ul>
      </Section>
    </>
  );
}

function ReplicationDocsSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-gray-400 leading-relaxed">
          {isDE
            ? 'DevGrimoire kann Daten zwischen zwei Instanzen synchronisieren — entweder einseitig (Master/Slave für Backups) oder bidirektional (Peer-Mode für verteiltes Arbeiten zwischen z.B. Heim- und Firmen-Instanz).'
            : 'DevGrimoire can synchronize data between two instances — either unidirectionally (master/slave for backups) or bidirectionally (peer mode for distributed work between e.g. home and office instances).'}
        </p>
      </Section>

      <Section title={isDE ? 'Rollen' : 'Roles'}>
        <ul className="text-gray-400 text-sm space-y-2 list-disc list-inside">
          <li><span className="font-mono text-gray-300">standalone</span> {isDE ? '— Default, keine Replikation' : '— default, no replication'}</li>
          <li><span className="font-mono text-gray-300">master</span> → <span className="font-mono text-gray-300">slave</span> {isDE ? '— Einweg-Replikation für Backup. Slave ist Read-Only, kann zum Master promoted werden (Failover).' : '— one-way replication for backup. Slave is read-only, can be promoted to master (failover).'}</li>
          <li><span className="font-mono text-gray-300">peer</span> ↔ <span className="font-mono text-gray-300">peer</span> {isDE ? '— bidirektional symmetrisch. Beide Instanzen pushen lokale Änderungen, beide bleiben voll schreibbar. Konflikte werden via Last-Write-Wins (auf updatedAt) gelöst.' : '— symmetric bidirectional. Both instances push local changes, both stay fully writable. Conflicts resolved via last-write-wins (on updatedAt).'}</li>
        </ul>
      </Section>

      <Section title={isDE ? 'Per-Projekt-Opt-In' : 'Per-Project Opt-In'}>
        <p className="text-gray-400 text-sm mb-3">
          {isDE
            ? 'Replikation läuft nur für Projekte die du explizit freigegeben hast (Settings → Replikation → Checkbox-Liste). Persönliche Projekte ohne Opt-in bleiben lokal — selbst wenn die Replikations-Verbindung steht. Default für alle bestehenden Projekte: nicht-repliziert.'
            : 'Replication only runs for projects you explicitly enable (Settings → Replication → checkbox list). Personal projects without opt-in stay local — even when the replication link is up. Default for all existing projects: not replicated.'}
        </p>
        <p className="text-gray-400 text-sm">
          {isDE
            ? 'Use-Case: Heim-Instanz hat alle Projekte, du gibst nur die Arbeits-Projekte zur Firmen-Instanz frei. Persönliche Projekte werden nie zur Firma gesynct.'
            : 'Use case: home instance has all projects; you only enable work projects to flow to the office instance. Personal projects never sync to the office.'}
        </p>
      </Section>

      <Section title={isDE ? 'Last-Write-Wins (Peer-Mode)' : 'Last-Write-Wins (Peer Mode)'}>
        <p className="text-gray-400 text-sm mb-3">
          {isDE
            ? 'Bei eingehender Änderung vergleicht der Empfänger die updatedAt-Timestamps. Älteres Incoming wird verworfen mit Log-Eintrag "LWW skipped". Bei simultanen Edits beider Seiten geht der frühere Edit verloren — bewusste Wahl gegen Komplexität von Vector Clocks oder CRDTs.'
            : 'On incoming change, the receiver compares updatedAt timestamps. Older incoming is discarded with log entry "LWW skipped". On simultaneous edits from both sides, the earlier edit is lost — deliberate choice against the complexity of vector clocks or CRDTs.'}
        </p>
        <div className="bg-amber-900/20 border border-amber-800/40 rounded px-3 py-2 text-amber-200 text-xs">
          {isDE
            ? '⚠ Beide Peer-Instanzen müssen NTP-synchron laufen, sonst wird LWW willkürlich (1 Sekunde Drift = Race Condition). Delete-Events bleiben unbedingt — kein LWW-Check.'
            : '⚠ Both peer instances must be NTP-synchronized, otherwise LWW becomes arbitrary (1 second drift = race condition). Delete events always apply — no LWW check.'}
        </div>
      </Section>

      <Section title="Setup">
        <ol className="text-gray-400 text-sm space-y-2 list-decimal list-inside">
          <li>{isDE ? 'Auf beiden Instanzen Settings → Replikation → Rolle: Peer (bidirektional)' : 'On both instances Settings → Replication → Role: Peer (bidirectional)'}</li>
          <li>{isDE ? 'PeerUrl + PeerApiKey je Seite mit der Adresse der Gegenseite eintragen' : 'Enter peer URL + peer API key on each side pointing at the other instance'}</li>
          <li>{isDE ? 'Beide Instanzen müssen denselben SECRETS_ENCRYPTION_KEY haben (sonst können verschlüsselte Secrets nicht entschlüsselt werden)' : 'Both instances must share the same SECRETS_ENCRYPTION_KEY (else encrypted secrets cannot be decrypted)'}</li>
          <li>{isDE ? 'NTP-Sync auf beiden Hosts sicherstellen (timedatectl status / chronyc tracking)' : 'Ensure NTP sync on both hosts (timedatectl status / chronyc tracking)'}</li>
          <li>{isDE ? 'In der Project-Liste (gleicher Tab) die Projekte ankreuzen die replizieren sollen' : 'In the project list (same tab) tick the projects to replicate'}</li>
          <li>{isDE ? '"Verbindung testen" → grün, dann "Jetzt synchronisieren" für initialen Full-Sync' : '"Test connection" → green, then "Sync now" for initial full sync'}</li>
        </ol>
      </Section>

      <Section title={isDE ? 'Offline-Verhalten' : 'Offline Behaviour'}>
        <p className="text-gray-400 text-sm mb-3">
          {isDE
            ? 'Wenn der Peer offline ist, queuen sich die Änderungen in MongoDB. Beim Reconnect läuft die Queue ab, ein nächtlicher Full-Sync (Default 3:00 Uhr) backfillt was die Queue verpasst hat (z.B. wegen Queue-Overflow oder Down-Time länger als 24h).'
            : 'When the peer is offline, changes queue in MongoDB. On reconnect the queue drains; a nightly full sync (default 3:00 AM) backfills what the queue missed (e.g. due to queue overflow or downtime > 24h).'}
        </p>
        <p className="text-gray-400 text-sm">
          {isDE
            ? 'Anwendungsfall: arbeite zu Hause weiter, wenn Firmen-Server-Verbindung tot ist — Edits werden lokal angewendet und gequeued, bei nächster Verbindung gepusht. Wenn die Firma in der Zwischenzeit auch was am gleichen Doc geändert hat, gewinnt der jüngere updatedAt.'
            : 'Use case: keep working at home when the office server connection is down — edits apply locally and queue, get pushed on next connection. If the office also changed the same doc meanwhile, the newer updatedAt wins.'}
        </p>
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
