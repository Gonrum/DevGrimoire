import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import i18n from '../i18n';

type DocsSection = 'overview' | 'setup' | 'auth' | 'mcp' | 'ui' | 'projektarbeit' | 'wissen' | 'crm' | 'ops' | 'rag' | 'chat' | 'workflows' | 'replication' | 'api' | 'logs' | 'git' | 'architecture';

export default function Docs() {
  const [active, setActive] = useState<DocsSection>('overview');
  const { t } = useTranslation();
  const isDE = i18n.language === 'de';

  const sections: { key: DocsSection; label: string }[] = [
    { key: 'overview', label: t('docs.navOverview') },
    { key: 'setup', label: t('docs.navSetup') },
    { key: 'auth', label: t('docs.navAuth') },
    { key: 'mcp', label: t('docs.navMcp') },
    { key: 'ui', label: 'UI' },
    { key: 'projektarbeit', label: isDE ? 'Projektarbeit' : 'Project Work' },
    { key: 'wissen', label: isDE ? 'Wissen' : 'Knowledge' },
    { key: 'crm', label: 'CRM' },
    { key: 'ops', label: 'Ops' },
    { key: 'rag', label: 'RAG' },
    { key: 'chat', label: 'Chat' },
    { key: 'workflows', label: t('docs.navWorkflows', { defaultValue: 'Workflows' }) },
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
        {active === 'ui' && <UiSection />}
        {active === 'projektarbeit' && <ProjektarbeitSection />}
        {active === 'wissen' && <WissenSection />}
        {active === 'crm' && <CrmSection />}
        {active === 'ops' && <OpsSection />}
        {active === 'rag' && <RagSection />}
        {active === 'chat' && <ChatSection />}
        {active === 'workflows' && <WorkflowDocsSection />}
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
            <EnvVar name="MONGO_PASSWORD" desc={isDE ? 'MongoDB-Passwort' : 'MongoDB password'} />
            <EnvVar name="AUTH_USERNAME / AUTH_PASSWORD" desc={isDE ? 'Initiales Admin-Konto (wird beim Start in DB angelegt)' : 'Initial admin account (created in DB on startup)'} />
            <EnvVar name="JWT_SECRET" desc={isDE ? 'Geheimnis f\u00fcr JWT-Signierung' : 'Secret for JWT signing'} />
            <EnvVar name="WORKSPACE_API_TOKEN" desc={isDE ? 'Pflicht-Secret f\u00fcr Backend \u2194 Workspace-Sidecar' : 'Required secret for backend \u2194 workspace sidecar'} />
            <EnvVar name="SEARXNG_SECRET" desc={isDE ? 'Secret f\u00fcr die interne SearXNG-Instanz' : 'Secret for the internal SearXNG instance'} />
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
            {isDE
              ? (<>Empfohlen: <Mono>claude mcp add</Mono> registriert den Server in der CLI &mdash; ohne manuelles Editieren von <Mono>~/.claude.json</Mono>.</>)
              : (<>Recommended: <Mono>claude mcp add</Mono> registers the server in the CLI &mdash; no manual editing of <Mono>~/.claude.json</Mono> required.</>)}
          </p>
          <Code>{`# Ohne Auth (Streamable HTTP, empfohlen)
claude mcp add --transport http devgrimoire http://[server]/mcp

# Mit API-Key (Header — empfohlen, Streamable HTTP)
claude mcp add --transport http devgrimoire http://[server]/mcp \\
  --header "Authorization: Bearer cv_..."

# Mit API-Key (Query-Parameter, SSE)
claude mcp add --transport sse devgrimoire "http://[server]/sse?apiKey=cv_..."`}</Code>
          <Hint>
            {isDE ? (
              <>
                <Mono>--scope user</Mono> macht den Server global verf&uuml;gbar, <Mono>--scope project</Mono> bindet ihn an das aktuelle Projekt, ohne Flag landet er nur lokal in diesem Repo.
              </>
            ) : (
              <>
                <Mono>--scope user</Mono> makes the server available globally, <Mono>--scope project</Mono> ties it to the current project, without a flag it stays local to this repo.
              </>
            )}
          </Hint>

          <details className="mt-4 group">
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 select-none">
              {isDE ? 'Alternative: manuelles JSON-Editing' : 'Alternative: manual JSON editing'}
            </summary>
            <p className="text-gray-400 text-sm mt-3 mb-2">
              {isDE ? (<>In <Mono>~/.claude.json</Mono>:</>) : (<>In <Mono>~/.claude.json</Mono>:</>)}
            </p>
            <Code>{`{
  "mcpServers": {
    "devgrimoire": {
      "type": "sse",
      "url": "http://[server]/sse?apiKey=cv_..."
    }
  }
}`}</Code>
            <p className="text-gray-500 text-xs mt-2">
              {isDE
                ? 'Wenn Auth deaktiviert ist, kann der apiKey-Query-Parameter weggelassen werden.'
                : 'If auth is disabled, the apiKey query parameter can be omitted.'}
            </p>
          </details>
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
      "args": ["-y", "mcp-remote", "http://[server]/sse?apiKey=cv_...", "--allow-http"]
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
              <span>SSE (Claude Code, Claude Desktop, mcp-remote)</span>
            </div>
            <div className="flex gap-3">
              <code className="text-green-400 shrink-0 w-44">POST /messages</code>
              <span>{isDE ? 'SSE Message-Endpoint' : 'SSE message endpoint'}</span>
            </div>
            <div className="flex gap-3">
              <code className="text-cyan-400 shrink-0 w-44">POST|GET|DELETE /mcp</code>
              <span>{isDE ? 'Streamable HTTP (empfohlen für neuere Clients und Multi-Session)' : 'Streamable HTTP (recommended for newer clients and multi-session)'}</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title={isDE ? 'Bridge via mcp-remote (LM Studio, Claude Desktop, ...)' : 'Bridge via mcp-remote (LM Studio, Claude Desktop, ...)'}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE ? (
            <>
              Clients ohne native MCP-HTTP-Unterst&uuml;tzung (LM Studio, Claude Desktop, Cursor &hellip;) sprechen den Server &uuml;ber{' '}
              <Mono>mcp-remote</Mono> an &mdash; eine kleine Node-Bridge, die als <Mono>command</Mono> in der Client-Config gestartet wird
              und intern zu <Mono>/sse</Mono> verbindet. Node.js auf dem Client-Rechner ist die einzige Voraussetzung &mdash;
              kein direkter MongoDB-Zugriff n&ouml;tig.
            </>
          ) : (
            <>
              Clients without native MCP-HTTP support (LM Studio, Claude Desktop, Cursor &hellip;) reach the server via{' '}
              <Mono>mcp-remote</Mono> &mdash; a small Node bridge launched as <Mono>command</Mono> in the client config that
              internally connects to <Mono>/sse</Mono>. Node.js on the client machine is the only prerequisite &mdash;
              no direct MongoDB access required.
            </>
          )}
        </p>

        <Step n={1} title="LM Studio">
          <p className="text-gray-400 text-sm mb-2">
            {isDE
              ? (<>In den LM Studio MCP-Einstellungen (<Mono>mcp.json</Mono>):</>)
              : (<>In LM Studio's MCP settings (<Mono>mcp.json</Mono>):</>)}
          </p>
          <Code>{`{
  "mcpServers": {
    "devGrimoire": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://[server]/sse?apiKey=cv_...",
        "--allow-http"
      ]
    }
  }
}`}</Code>
        </Step>

        <Step n={2} title="Claude Desktop">
          <p className="text-gray-400 text-sm mb-2">
            {isDE
              ? (<>In <Mono>claude_desktop_config.json</Mono>:</>)
              : (<>In <Mono>claude_desktop_config.json</Mono>:</>)}
          </p>
          <Code>{`{
  "mcpServers": {
    "devgrimoire": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://[server]/sse?apiKey=cv_...", "--allow-http"]
    }
  }
}`}</Code>
        </Step>

        <Hint>
          {isDE ? (
            <>
              <Mono>--allow-http</Mono> ist n&ouml;tig, da <Mono>mcp-remote</Mono> standardm&auml;&szlig;ig nur HTTPS akzeptiert.
              Hinter einem HTTPS-Reverse-Proxy kann das Flag weg.
              Config-Pfade Claude Desktop:
              macOS <Mono>~/Library/Application Support/Claude/claude_desktop_config.json</Mono>,
              Linux <Mono>~/.config/Claude/claude_desktop_config.json</Mono>.
            </>
          ) : (
            <>
              <Mono>--allow-http</Mono> is required because <Mono>mcp-remote</Mono> only accepts HTTPS by default.
              Behind an HTTPS reverse proxy, the flag can be dropped.
              Claude Desktop config paths:
              macOS <Mono>~/Library/Application Support/Claude/claude_desktop_config.json</Mono>,
              Linux <Mono>~/.config/Claude/claude_desktop_config.json</Mono>.
            </>
          )}
        </Hint>
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
            {isDE
              ? (<>Empfohlen via <Mono>claude mcp add</Mono>:</>)
              : (<>Recommended via <Mono>claude mcp add</Mono>:</>)}
          </p>
          <Code>{`# Header-Variante (Streamable HTTP, empfohlen)
claude mcp add --transport http devgrimoire http://[server]/mcp \\
  --header "Authorization: Bearer cv_..."

# Query-Parameter (SSE — nutzbar wenn Header nicht gesetzt werden können)
claude mcp add --transport sse devgrimoire "http://[server]/sse?apiKey=cv_..."`}</Code>
          <p className="text-gray-500 text-xs mt-2">
            {isDE ? (
              <>
                <Mono>SSE</Mono> nutzt <Mono>?apiKey=</Mono> im URL, weil EventSource keine Custom-Header unterst&uuml;tzt. Wenn Header m&ouml;glich sind &rarr; Streamable HTTP (<Mono>/mcp</Mono>) bevorzugen.
              </>
            ) : (
              <>
                <Mono>SSE</Mono> uses <Mono>?apiKey=</Mono> in the URL because EventSource does not support custom headers. If headers are possible, prefer Streamable HTTP (<Mono>/mcp</Mono>).
              </>
            )}
          </p>

          <details className="mt-4 group">
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 select-none">
              {isDE ? 'Alternative: manuelles JSON-Editing' : 'Alternative: manual JSON editing'}
            </summary>
            <p className="text-gray-400 text-sm mt-3 mb-2">
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
              {isDE ? 'Header-Variante (Streamable HTTP):' : 'Header variant (Streamable HTTP):'}
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
          </details>
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
  const [tools, setTools] = useState<{ name: string; description: string; group: string; isWrite: boolean }[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.mcp.tools().then((list) => { if (!cancelled) setTools(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const countLabel = tools.length || '\u2026';
  return (
    <>
      <Section title={isDE ? `MCP-Tools (${countLabel})` : `MCP Tools (${countLabel})`}>
        <p className="text-gray-400 text-sm mb-4">
          {isDE
            ? `Nach dem Anbinden stehen Claude ${countLabel} Tools zur Verf\u00fcgung, hier live aus dem Server geladen und nach Gruppe sortiert. Read-Tools sind gr\u00fcn, Write-Tools orange. List-Tools liefern kompakte Metadaten, Details holst du \u00fcber _get-Tools \u2014 das schont den Context.`
            : `After connecting, Claude has access to ${countLabel} tools, listed here live from the server grouped by category. Read tools are green, write tools orange. List tools return compact metadata; details are fetched via _get tools \u2014 keeping context lean.`}
        </p>
        <McpToolsLive tools={tools} isDE={isDE} />
      </Section>
    </>
  );
}


function UiSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'UI-Grundsatz' : 'UI Principle'}>
        <p className="text-gray-400 text-sm leading-relaxed">
          {isDE
            ? 'Neue Oberflächen sollen aus vorhandenen Komponenten und wiederverwendbaren Primitives entstehen. Wenn ein Pattern mehrfach vorkommt, wird es als Komponente ergänzt oder eine bestehende Komponente erweitert, statt Tailwind-Klassen pro Seite neu zu kopieren.'
            : 'New UI should be built from existing components and reusable primitives. If a pattern appears more than once, add a component or extend an existing one instead of copying page-local Tailwind classes.'}
        </p>
      </Section>

      <Section title={isDE ? 'Komponenten' : 'Components'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Button" value={<><Mono>components/ui/Button.tsx</Mono> - {isDE ? 'primäre, neutrale, destruktive und Ghost-Actions' : 'primary, neutral, destructive, and ghost actions'}</>} />
          <InfoRow label="ConfirmButton" value={<><Mono>components/ui/ConfirmButton.tsx</Mono> - {isDE ? 'Bestätigung für irreversible Aktionen' : 'confirmation for irreversible actions'}</>} />
          <InfoRow label="Badge" value={<><Mono>components/ui/Badge.tsx</Mono> - {isDE ? 'Status und kompakte Metadaten' : 'status and compact metadata'}</>} />
          <InfoRow label="Card" value={<><Mono>components/ui/Card.tsx</Mono> - {isDE ? 'gerahmte Items und Panels, keine Card-in-Card-Layouts' : 'framed items and panels, no card-in-card layouts'}</>} />
          <InfoRow label="FormField" value={<><Mono>components/ui/FormField.tsx</Mono> - {isDE ? 'Standardfelder mit Labels und konsistentem Fokus-State' : 'standard fields with labels and consistent focus state'}</>} />
          <InfoRow label="Dialog" value={<><Mono>components/ui/Dialog.tsx</Mono> - {isDE ? 'Modal-Shell mit Portal' : 'modal shell with portal'}</>} />
          <InfoRow label="MarkdownEditor" value={<><Mono>components/MarkdownEditor.tsx</Mono> - {isDE ? 'Markdown-Eingabe mit Vorschau' : 'Markdown input with preview'}</>} />
        </div>
      </Section>

      <Section title={isDE ? 'Formulare und Layout' : 'Forms and Layout'}>
        <ul className="text-sm text-gray-400 space-y-2 list-disc list-inside">
          <li>{isDE ? 'Wiederkehrende Create/Edit/Detail-Flows sollen eine gemeinsame Page- oder Modal-Shell verwenden.' : 'Repeated create/edit/detail flows should use a shared page or modal shell.'}</li>
          <li>{isDE ? 'Felder in Flex-Reihen brauchen einen explizit wachsenden Wrapper; w-full am inneren input reicht nicht.' : 'Fields inside flex rows need an explicitly growing wrapper; w-full on the inner input is not enough.'}</li>
          <li>{isDE ? 'Field-with-Action-Patterns, z.B. Eingabe plus Dictation-Button, sollen als wiederverwendbares Layout umgesetzt werden.' : 'Field-with-action patterns, such as input plus dictation button, should be implemented as reusable layout primitives.'}</li>
          <li>{isDE ? 'Negative Margins zur Formularausrichtung vermeiden; stattdessen den Layout-Contract korrigieren.' : 'Avoid negative margins for form alignment; fix the layout contract instead.'}</li>
          <li>{isDE ? 'Mobile Breakpoints explizit planen: volle Breite, stabile Action-Slots, kein Text-Overflow.' : 'Plan mobile breakpoints explicitly: full width, stable action slots, no text overflow.'}</li>
        </ul>
      </Section>

      <Section title={isDE ? 'Visuelle Sprache' : 'Visual Language'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Oberflächen' : 'Surfaces'} value="gray-950 / gray-900 / gray-800" />
          <InfoRow label={isDE ? 'Rahmen' : 'Borders'} value="gray-800 / gray-700" />
          <InfoRow label={isDE ? 'Akzent' : 'Accent'} value="violet, cyan" />
          <InfoRow label={isDE ? 'Status' : 'Status'} value="green, yellow, red, gray" />
          <InfoRow label={isDE ? 'Effekte' : 'Effects'} value={<><Mono>glow-violet</Mono>, <Mono>glow-cyan</Mono>, <Mono>grimoire-card</Mono>, <Mono>grimoire-divider</Mono></>} />
        </div>
        <Hint>
          {isDE
            ? 'Effekte sparsam einsetzen. Operative Oberflächen sollen dicht, ruhig und scanbar bleiben.'
            : 'Use effects sparingly. Operational screens should stay dense, quiet, and scannable.'}
        </Hint>
      </Section>

      <Section title={isDE ? 'Review-Checkliste' : 'Review Checklist'}>
        <ul className="text-sm text-gray-400 space-y-2 list-disc list-inside">
          <li>{isDE ? 'Bestehende Komponenten wurden verwendet oder erweitert.' : 'Existing components were used or extended.'}</li>
          <li>{isDE ? 'Wiederholte Tailwind-Patterns wurden nicht lokal dupliziert.' : 'Repeated Tailwind patterns were not duplicated locally.'}</li>
          <li>{isDE ? 'Formfelder nutzen in Page- und Modal-Kontexten die volle verfügbare Breite.' : 'Form fields use the full available width in page and modal contexts.'}</li>
          <li>{isDE ? 'Button-Varianten, Badges und Statusfarben sind mit benachbarten Screens konsistent.' : 'Button variants, badges, and status colors are consistent with nearby screens.'}</li>
          <li>{isDE ? 'Mobile Layouts wurden auf Wrapping und Overflow geprüft.' : 'Mobile layouts were checked for wrapping and overflow.'}</li>
        </ul>
      </Section>
    </>
  );
}

function ProjektarbeitSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-sm text-gray-400 leading-relaxed">
          {isDE
            ? 'Alle projektzentrierten Datentypen für tägliche Arbeit: Projekte als Container, Todos mit State-Machine, Milestones zum Bündeln, Recurring-Tasks für wiederkehrende Arbeit, Releases für Versionierung, Dependencies und Changelog für Historie.'
            : 'All project-centric data types for daily work: projects as containers, todos with a state machine, milestones for grouping, recurring tasks for repeated work, releases for versioning, dependencies and changelog for history.'}
        </p>
      </Section>

      <Section title={isDE ? 'Projekte' : 'Projects'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Projects · Projects → Detail" />
          <InfoRow label={isDE ? 'Konzepte' : 'Concepts'} value={isDE ? 'aktiv/archiviert, Favoriten, Projekt-Tags, Customer-Verknüpfung' : 'active/archived, favorites, project tags, customer link'} />
          <InfoRow label="MCP" value={<>project_*, project_customer_links, project_tag_*</>} />
        </div>
      </Section>

      <Section title="Todos">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'State-Machine mit strikter Reihenfolge — Sprünge werden abgelehnt. Identifiziert per ID oder kurze Schlüssel wie T-3 (Projekt-Nummer).'
            : 'State machine with strict ordering — jumps are rejected. Identified by ID or short keys like T-3 (project-scoped number).'}
        </p>
        <Code>{`open  →  in_progress  →  review  →  done`}</Code>
        <div className="space-y-2 text-sm text-gray-400 mt-3">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Todos (Board / Liste)" />
          <InfoRow label={isDE ? 'Workflow' : 'Workflow'} value={isDE ? 'Start → in_progress, Implementierung, → review (Code-Review!), → done' : 'Start → in_progress, implement, → review (code review!), → done'} />
          <InfoRow label={isDE ? 'Kommentare' : 'Comments'} value="todo_comment" />
          <InfoRow label="MCP" value="todo_*, validation_report_*, oracle_*" />
        </div>
      </Section>

      <Section title="Milestones">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Bündeln zusammengehörige Todos und schließen mit Changelog-Eintrag ab. Abschluss verlangt eine changelogId. Identifiziert per ID oder M-1 (Projekt-Nummer).'
            : 'Bundle related todos and close out with a changelog entry. Closing requires a changelogId. Identified by ID or M-1 (project-scoped number).'}
        </p>
        <Code>{`open  →  in_progress  →  done  (changelogId required)`}</Code>
        <Hint>
          {isDE
            ? 'Jeder Changelog darf nur einmal einem Milestone zugeordnet werden. Erledigte Milestones archivieren statt löschen.'
            : 'Each changelog can only be assigned to one milestone. Archive completed milestones instead of deleting them.'}
        </Hint>
      </Section>

      <Section title={isDE ? 'Wiederkehrende Tasks' : 'Recurring Tasks'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Was' : 'What'} value={isDE ? 'Cron- oder Intervall-Plan, erzeugt automatisch Todos' : 'Cron or interval schedule that auto-creates todos'} />
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Recurring" />
          <InfoRow label="MCP" value="recurring_task_*" />
        </div>
      </Section>

      <Section title="Releases">
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Was' : 'What'} value={isDE ? 'Versions-Tracking pro Projekt mit Assets, Plattform, Status-Workflow' : 'Per-project version tracking with assets, platform, status workflow'} />
          <InfoRow label="GitLab-Sync" value={isDE ? 'release_sync_gitlab importiert Releases inkl. Assets aus dem verbundenen Repo' : 'release_sync_gitlab imports releases incl. assets from the connected repo'} />
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Releases" />
          <InfoRow label="MCP" value="release_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Abhängigkeiten' : 'Dependencies'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Was' : 'What'} value={isDE ? 'Paket-Abhängigkeiten pro Projekt (Name, Version, Manager)' : 'Per-project package dependencies (name, version, manager)'} />
          <InfoRow label="Scan" value={isDE ? 'dependency_scan importiert package.json, composer.json, requirements.txt, Cargo.toml, go.mod, pom.xml, *.csproj, Gemfile' : 'dependency_scan imports package.json, composer.json, requirements.txt, Cargo.toml, go.mod, pom.xml, *.csproj, Gemfile'} />
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Dependencies" />
          <InfoRow label="MCP" value="dependency_*" />
        </div>
      </Section>

      <Section title="Changelog">
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Was' : 'What'} value={isDE ? 'Versionierte Änderungshistorie pro Projekt mit Komponente, Typ (added/changed/fixed/removed)' : 'Versioned change history per project with component, type (added/changed/fixed/removed)'} />
          <InfoRow label={isDE ? 'Verknüpfung' : 'Linkage'} value={isDE ? 'Pflicht-Verknüpfung beim Milestone-Done' : 'Required link when closing a milestone'} />
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Changelog" />
          <InfoRow label="MCP" value="changelog_*" />
        </div>
      </Section>
    </>
  );
}

function WissenSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-sm text-gray-400 leading-relaxed">
          {isDE
            ? 'Alle Datentypen für die langlebige Projekt-Wissensbasis. Knowledge ist der zentrale Ort; spezialisierte Typen ergänzen ihn: Research für zeitpunktbezogene Quellen, Manuals als kategorisiertes Handbuch, Schemas für DB-Strukturen, Snippets für Code, der Graph für Beziehungen.'
            : 'All data types feeding the long-lived project knowledge base. Knowledge is the central place; specialized types extend it: research for time-stamped sources, manuals as a categorized handbook, schemas for DB structures, snippets for code, the graph for relations.'}
        </p>
      </Section>

      <Section title="Knowledge">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Volltext-durchsuchbare Wissenseinträge. Scopes: project (Default, projectId Pflicht) oder global (projektübergreifend). Mit projectId + global-Scope sieht man projekt-spezifische + globale Treffer kombiniert.'
            : 'Full-text searchable knowledge entries. Scopes: project (default, projectId required) or global (cross-project). With projectId + global scope you see project-specific and global hits combined.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Knowledge" />
          <InfoRow label={isDE ? 'Suche' : 'Search'} value={isDE ? 'knowledge_search (Keyword) · rag_search (semantisch, entity-übergreifend)' : 'knowledge_search (keyword) · rag_search (semantic, cross-entity)'} />
          <InfoRow label="MCP" value="knowledge_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Recherche' : 'Research'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Zeitpunktbezogene Recherchen mit Quellenangaben. Optional in Research-Sessions gruppiert (mehrere Steps mit Frage/Antwort/Quellen).'
            : 'Time-stamped research with source citations. Optionally grouped into research sessions (multi-step question/answer/sources).'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Research · Research-Sessions" />
          <InfoRow label="MCP" value="research_*, research_session_*, research_step_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Manual / Handbuch' : 'Manual'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Kategorisiertes Markdown-Handbuch pro Projekt — gut für stabile Anleitungen, die nicht in Knowledge gehören. Einträge mit Kategorie und Titel.'
            : 'Categorized Markdown handbook per project — best for stable how-tos that do not belong in Knowledge. Entries have category and title.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Manual" />
          <InfoRow label="MCP" value="manual_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Schemas (DB-Dokumentation)' : 'Schemas (DB Documentation)'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'DB-Tabellen / Collections mit Feldern, Typen, Indizes. Jedes schema_update legt automatisch einen Versions-Snapshot mit changeNote an (schema_versions zeigt die Historie).'
            : 'DB tables / collections with fields, types, indexes. Every schema_update auto-creates a version snapshot with changeNote (schema_versions returns history).'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Schemas" />
          <InfoRow label="MCP" value="schema_*, schema_versions" />
        </div>
      </Section>

      <Section title="Snippets">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Wiederverwendbare Code-Snippets mit Sprache, Tags und Kategorie. Volltextsuche über Inhalt und Titel.'
            : 'Reusable code snippets with language, tags, and category. Full-text search across content and title.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Snippets" />
          <InfoRow label="MCP" value="snippet_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Knowledge-Graph' : 'Knowledge Graph'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Typisierte Beziehungen zwischen Entities (Knowledge, Todo, Milestone, Schema, ...). knowledge_graph_link verbindet, _neighbors zeigt direkte Nachbarn, _discover & _impact propagieren entlang der Kanten.'
            : 'Typed relations between entities (Knowledge, Todo, Milestone, Schema, ...). knowledge_graph_link connects, _neighbors shows direct neighbors, _discover & _impact propagate along edges.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Knowledge Graph" />
          <InfoRow label="MCP" value="knowledge_graph_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Doc-Health & Update-Proposals' : 'Doc Health & Update Proposals'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Vorschläge, wo Doku veraltet ist oder fehlt. Lassen sich in Todos konvertieren (doc_update_proposal_convert_to_todo).'
            : 'Proposals where documentation is stale or missing. Can be converted into todos (doc_update_proposal_convert_to_todo).'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Doc Health" />
          <InfoRow label="MCP" value="doc_update_proposal_*" />
        </div>
      </Section>

      <Section title="Sessions">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Arbeitssitzungen mit Zusammenfassung, geänderten Dateien und nächsten Schritten — gedacht für nahtlosen Kontext-Wechsel zwischen Sessions.'
            : 'Work sessions with summary, changed files, and next steps — designed for seamless context handoff between sessions.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Sessions" />
          <InfoRow label="MCP" value="session_save, session_get" />
        </div>
      </Section>

      <Section title={isDE ? 'Souls (Projekt-Persönlichkeit)' : 'Souls (Project Personality)'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Persönlichkeit, Stimme und Prinzipien eines Projekts — fließt in den Chat-System-Prompt ein und gibt jedem Projekt Charakter.'
            : 'Personality, voice, and principles of a project — fed into the chat system prompt to give each project character.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Soul" />
          <InfoRow label="MCP" value="soul_get, soul_update" />
        </div>
      </Section>
    </>
  );
}

function CrmSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-sm text-gray-400 leading-relaxed">
          {isDE
            ? 'DevGrimoire enthält ein leichtes CRM für Kunden und Kontakte. Projekte können mit Customers verknüpft werden (1:n), Customers haben Contacts, Templates beschleunigen das Anlegen neuer Kunden mit Standard-Setup.'
            : 'DevGrimoire includes a light CRM for customers and contacts. Projects can link to customers (1:n), customers have contacts, templates speed up onboarding with a standard setup.'}
        </p>
      </Section>

      <Section title={isDE ? 'Kunden' : 'Customers'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Kunden-Stammdaten mit Status (aktiv/archiviert), Adressen, Notizen. Healthchecks werden pro Kunde gepflegt (siehe Ops → Monitoring).'
            : 'Customer master data with status (active/archived), addresses, notes. Healthchecks live per customer (see Ops → Monitoring).'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Customers · Customers → Detail" />
          <InfoRow label="MCP" value="customer_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Kontakte' : 'Contacts'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Ansprechpartner pro Kunde mit Rolle, E-Mail, Telefon, Notizen.'
            : 'Per-customer contacts with role, email, phone, notes.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Customer-Detail → Kontakte" />
          <InfoRow label="MCP" value="contact_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Projekt-Kunden-Verknüpfung' : 'Project-Customer Links'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Ein Projekt kann mit mehreren Kunden verknüpft sein (z.B. White-Label-Lösungen). Die Verknüpfung trägt eigene Metadaten wie Auftragsnummer oder Vertragsstart.'
            : 'A project can link to multiple customers (e.g. white-label solutions). The link itself carries metadata such as contract number or start date.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Customer-Links · Customer → Projects" />
          <InfoRow label="MCP" value="customer_project_link, customer_project_list, customer_project_unlink, customer_project_update, project_customer_links" />
        </div>
      </Section>

      <Section title={isDE ? 'Kunden-Templates' : 'Customer Templates'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Vordefiniertes Standard-Setup für neue Kunden — z.B. Default-Tags, Monitor-Konfiguration, initiale Notizen. customer_template_preview zeigt was angewendet würde, customer_template_apply führt es aus.'
            : 'Predefined setup for new customers — default tags, monitor configuration, initial notes. customer_template_preview previews; customer_template_apply executes.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Settings → Customer-Templates" />
          <InfoRow label="MCP" value="customer_template_*" />
        </div>
      </Section>
    </>
  );
}

function OpsSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Überblick' : 'Overview'}>
        <p className="text-sm text-gray-400 leading-relaxed">
          {isDE
            ? 'Operative Werkzeuge für laufenden Betrieb: Monitoring von Kunden-Endpunkten, SSH für entfernte Hosts, projektgebundene Code-Workspaces, Datei-Anhänge in MinIO, Push-Benachrichtigungen und der Audit-Log.'
            : 'Operational tooling for day-to-day work: monitoring of customer endpoints, SSH for remote hosts, project-bound code workspaces, file attachments in MinIO, push notifications, and the audit log.'}
        </p>
      </Section>

      <Section title={isDE ? 'Monitoring / Observatorium' : 'Monitoring / Observatory'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'HTTP-Healthchecks pro Kunde. Status-Modell: unknown → healthy / degraded / unhealthy / paused. Ein Scheduler läuft jede Minute, in-memory Lock verhindert Doppelausführungen.'
            : 'HTTP healthchecks per customer. Status model: unknown → healthy / degraded / unhealthy / paused. A scheduler runs every minute, an in-memory lock prevents double execution.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Sensible Header' : 'Sensitive headers'} value={isDE ? 'secretHeaders [{name, secretId}] werden zur Laufzeit aus dem Secret-Store aufgelöst, niemals persistiert' : 'secretHeaders [{name, secretId}] resolved from secret store at runtime, never persisted'} />
          <InfoRow label={isDE ? 'Failure-Notification' : 'Failure notification'} value={isDE ? 'consecutiveFailures ≥ failureThreshold → UNHEALTHY + einmalige Push-Notification (debounced via lastNotifiedStatus)' : 'consecutiveFailures ≥ failureThreshold → UNHEALTHY + single push notification (debounced via lastNotifiedStatus)'} />
          <InfoRow label="History TTL" value={isDE ? '30 Tage via MongoDB-TTL-Index' : '30 days via MongoDB TTL index'} />
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Customer-Detail → Observatorium" />
          <InfoRow label="MCP" value="monitor_*" />
        </div>
      </Section>

      <Section title="SSH">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Pro Projekt definierte SSH-Verbindungen für Wartung und Deploy. Auth via Passwort oder Key (verschlüsselt gespeichert). Kommandos synchron oder asynchron, Datei-Operationen (list, upload, download), Session-Tracking inkl. Audit.'
            : 'Per-project SSH connections for maintenance and deploy. Auth via password or key (stored encrypted). Commands sync or async, file ops (list, upload, download), session tracking incl. audit.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → SSH (Connections, Terminal, Audit)" />
          <InfoRow label={isDE ? 'Schlüssel-Tools' : 'Key tools'} value="ssh_exec, ssh_exec_async, ssh_list_files, ssh_upload, ssh_download" />
          <InfoRow label="MCP" value="ssh_connection_*, ssh_*" />
        </div>
      </Section>

      <Section title="Workspaces">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Projektgebundene Code-Workspaces im Sidecar-Container. workspace_clone holt ein Repo, workspace_read/_search/_tree lesen, workspace_exec führt begrenzte Build-/Test-Befehle aus. Artefakte landen als Attachments.'
            : 'Project-bound code workspaces in the sidecar container. workspace_clone fetches a repo, workspace_read/_search/_tree read, workspace_exec runs bounded build/test commands. Artifacts are saved as attachments.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Voraussetzung' : 'Prerequisite'} value={<>WORKSPACE_API_TOKEN (Backend ↔ Sidecar)</>} />
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Project → Workspaces" />
          <InfoRow label="MCP" value="workspace_*" />
        </div>
      </Section>

      <Section title={isDE ? 'Anhänge (Attachments)' : 'Attachments'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Optional — nur aktiv, wenn MinIO konfiguriert ist. Anhänge an Todos oder standalone. Text-Dateien und PDFs werden serverseitig extrahiert und in den RAG-Index aufgenommen. Große Binärdateien per REST downloaden, nicht per MCP.'
            : 'Optional — only active if MinIO is configured. Attachments on todos or standalone. Text files and PDFs are extracted server-side and indexed in RAG. Download large binaries via REST, not via MCP.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="REST" value={<><Mono>GET /api/attachments/:id/download</Mono></>} />
          <InfoRow label="MCP" value="attachment_*, workspace_attachment_save" />
          <InfoRow label="env" value="MINIO_ENDPOINT, MINIO_BUCKET, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_USE_SSL, MINIO_MAX_FILE_SIZE" />
        </div>
      </Section>

      <Section title={isDE ? 'Benachrichtigungen' : 'Notifications'}>
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'In-App Inbox (Glocke oben rechts) plus optional Web-Push (VAPID). notify_user als MCP-Tool sendet aktiv eine Notification, ask_user fragt interaktiv und wartet auf eine Antwort.'
            : 'In-app inbox (bell, top-right) plus optional web push (VAPID). notify_user as an MCP tool actively pushes; ask_user asks interactively and waits for a reply.'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value={isDE ? 'Glocke (Topbar) · Profil → Push abonnieren' : 'Bell (topbar) · Profile → subscribe to push'} />
          <InfoRow label="MCP" value="notify_user, ask_user, question_*" />
        </div>
      </Section>

      <Section title="Audit-Log">
        <p className="text-sm text-gray-400 mb-3">
          {isDE
            ? 'Aufzeichnung von User-Aktionen, Logins/Logouts und Schreib-Tool-Aufrufen aus dem Chat (mit User, Session, Tool, gekürzten Args).'
            : 'Record of user actions, logins/logouts, and write-tool calls from chat (with user, session, tool, truncated args).'}
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Wo im UI' : 'Where in UI'} value="Audit Log (Admin-Menü)" />
        </div>
      </Section>
    </>
  );
}

function McpToolsLive({ tools, isDE }: { tools: { name: string; description: string; group: string; isWrite: boolean }[]; isDE: boolean }) {
  if (!tools.length) {
    return <p className="text-sm text-gray-500">{isDE ? 'Tools werden geladen …' : 'Loading tools …'}</p>;
  }
  const grouped: Record<string, typeof tools> = {};
  for (const t of tools) {
    if (!grouped[t.group]) grouped[t.group] = [];
    grouped[t.group].push(t);
  }
  return (
    <>
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group} className="mb-5">
          <h3 className="text-sm font-medium text-gray-300 mb-2">
            {group}
            <span className="ml-2 text-xs text-gray-500">({items.length})</span>
          </h3>
          <div className="space-y-1">
            {items.map((t) => (
              <div key={t.name} className="flex gap-3 text-sm items-baseline">
                <code className={`shrink-0 w-52 truncate ${t.isWrite ? 'text-orange-400' : 'text-green-400'}`} title={t.name}>{t.name}</code>
                <span className="text-gray-500 text-xs leading-snug">{t.description}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
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
              g&uuml;ltigen JWT Bearer Token oder einen API Key. Endpunkte mit <span className="text-purple-400">(Admin)</span> erfordern die Admin-Rolle.
            </>
          ) : (
            <>
              The backend provides a REST API under <Mono>/api</Mono>.
              With auth enabled, all endpoints (except <Mono>/api/auth/*</Mono>) require a
              valid JWT bearer token or an API key. Endpoints marked <span className="text-purple-400">(Admin)</span> require the admin role.
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
            ? 'DevGrimoire enthält ein integriertes RAG-System (Retrieval-Augmented Generation) für semantische Suche über indexierte Content-Entitäten eines Projekts. Anders als Keyword-Suche versteht RAG Bedeutung — eine Suche nach "wie deploye ich das" findet auch Einträge über "Docker Compose Setup" oder "CI/CD Pipeline".'
            : 'DevGrimoire includes a built-in RAG system (Retrieval-Augmented Generation) for semantic search across indexed content entities in a project. Unlike keyword search, RAG understands meaning — searching for "how do I deploy" also finds entries about "Docker Compose setup" or "CI/CD pipeline".'}
        </p>
      </Section>

      <Section title={isDE ? 'Wie es funktioniert' : 'How It Works'}>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Vector DB" value={isDE ? 'LanceDB (embedded, kein extra Service nötig)' : 'LanceDB (embedded, no extra service needed)'} />
          <InfoRow label="Embeddings" value={isDE ? 'Ollama (CPU) oder OpenAI-kompatible API wie LM Studio (GPU)' : 'Ollama (CPU) or OpenAI-compatible API like LM Studio (GPU)'} />
          <InfoRow label={isDE ? 'Indizierte Entitäten' : 'Indexed Entities'} value="Knowledge, Research, Manuals, Changelogs, Todos, Sessions, Snippets, Attachments, Schemas" />
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
RAG_FALLBACK_URL=http://host.docker.internal:11434
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
          { name: 'rag_search', desc: isDE ? 'Semantische Suche (query, projectId?, entity?, limit?; entity enthält schema)' : 'Semantic search (query, projectId?, entity?, limit?; entity includes schema)' },
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
              <td className="py-2 pr-4">{isDE ? 'Indexierte Content-Entitäten (Knowledge, Research, Manual, Changelog, Todo, Session, Snippet, Attachment, Schema)' : 'Indexed content entities (Knowledge, Research, Manual, Changelog, Todo, Session, Snippet, Attachment, Schema)'}</td>
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
          <EnvVar name="OLLAMA_URL" desc={isDE ? 'Ollama-URL (Docker: http://host.docker.internal:11434, lokal: http://localhost:11434)' : 'Ollama URL (Docker: http://host.docker.internal:11434, local: http://localhost:11434)'} />
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
            ? 'Ollama: nutze "openai-compatible". Läuft das Backend in Docker und Ollama auf dem Host, verwende http://host.docker.internal:11434; bei lokalem Backend ist http://localhost:11434 korrekt. Der native ollama-Provider wurde entfernt (M-12), bestehende Configs migrieren automatisch. Ollama\'s /v1-Shim unterstützt seit v0.3 Function-Calling und Vision.'
            : 'Ollama: use "openai-compatible". If the backend runs in Docker and Ollama runs on the host, use http://host.docker.internal:11434; for a local backend, http://localhost:11434 is correct. The native ollama provider was retired (M-12); existing configs auto-migrate. Ollama\'s /v1 shim supports function calling and vision since v0.3.'}
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

function WorkflowDocsSection() {
  const isDE = i18n.language === 'de';
  return (
    <>
      <Section title={isDE ? 'Workflows im MVP' : 'Workflow MVP'}>
        <p className="text-sm text-gray-400 leading-relaxed mb-3">
          {isDE
            ? 'Workflows sind versionierte, sichtbare Automationen für wiederholbare Mehrschritt-Arbeit. Sie ergänzen Todos, Recurring Tasks und Chat: einfache Aufgaben bleiben Todos, einfache Zeitpläne bleiben Recurring Tasks, interaktive Einzelfragen bleiben Chat.'
            : 'Workflows are versioned, inspectable automations for repeatable multi-step work. They complement todos, recurring tasks, and chat: simple work stays a todo, simple schedules stay recurring tasks, and one-off interactive questions stay in chat.'}
        </p>
        <div className="grid md:grid-cols-2 gap-3">
          <FeatureCard
            title={isDE ? 'Definition, Trigger, Nodes, Runs' : 'Definitions, triggers, nodes, runs'}
            desc={isDE ? 'Die Kernbegriffe und MVP-Grenzen stehen in docs/workflows.md.' : 'Core concepts and MVP boundaries live in docs/workflows.md.'}
          />
          <FeatureCard
            title={isDE ? 'Sicherheit zuerst' : 'Security first'}
            desc={isDE ? 'Secrets bleiben Referenzen, Logs werden maskiert, Schreib-/Run-Tools sind allowlist-pflichtig.' : 'Secrets stay as references, logs are masked, and write/run tools require explicit allowlists.'}
          />
        </div>
      </Section>

      <Section title={isDE ? 'Beispiel-Workflows' : 'Example workflows'}>
        <div className="space-y-3 text-sm text-gray-400">
          <InfoRow label={isDE ? 'Projekt-Triage' : 'Project triage'} value={isDE ? 'Wöchentlich offene Todos, Blocker und Risiken zusammenfassen.' : 'Summarize open todos, blockers, and risks weekly.'} />
          <InfoRow label={isDE ? 'Customer-Monatscheck' : 'Monthly customer check'} value={isDE ? 'Monitoring, offene Kundentodos und notwendige Rückfragen bündeln.' : 'Collect monitoring, open customer todos, and required follow-up questions.'} />
          <InfoRow label={isDE ? 'Release-Checkliste' : 'Release checklist'} value={isDE ? 'Validierung, Changelog, Docs-Hinweise und Freigabe-Schritte koordinieren.' : 'Coordinate validation, changelog, documentation hints, and approval steps.'} />
        </div>
        <p className="text-xs text-gray-500 mt-3">
          {isDE
            ? 'Details, Template-Katalog und Agent-Hinweise: docs/workflow-examples.md und docs/workflow-template-wizard.md.'
            : 'Details, template catalog, and agent guidance: docs/workflow-examples.md and docs/workflow-template-wizard.md.'}
        </p>
      </Section>

      <Section title={isDE ? 'Agent- und Run-Debugging' : 'Agent and run debugging'}>
        <ul className="list-disc list-inside space-y-2 text-sm text-gray-400">
          <li>{isDE ? 'Agents lesen Workflow-Definition und Run-Historie, bevor sie Runs fortsetzen oder replayen.' : 'Agents read workflow definitions and run history before continuing or replaying runs.'}</li>
          <li>{isDE ? 'Node-Inputs, Outputs und Logs werden nur als maskierte, gekürzte Previews angezeigt.' : 'Node inputs, outputs, and logs are shown only as masked, truncated previews.'}</li>
          <li>{isDE ? 'Replay/Retry erzeugt eigene Child-Runs statt bestehende Historie zu überschreiben.' : 'Replay/retry creates linked child runs instead of overwriting existing history.'}</li>
        </ul>
        <Hint>
          {isDE
            ? 'n8n ist Inspiration für schnelle Iteration und sichtbare Node-Outputs; DevGrimoire bleibt aber projekt-, kunden- und agenten-scope-bewusst.'
            : 'n8n inspires fast iteration and visible node outputs, but DevGrimoire stays project-, customer-, and agent-scope aware.'}
        </Hint>
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
