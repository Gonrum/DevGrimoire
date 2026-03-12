import { useState } from 'react';

type DocsSection = 'overview' | 'setup' | 'auth' | 'mcp' | 'api' | 'architecture';

const sections: { key: DocsSection; label: string }[] = [
  { key: 'overview', label: 'Überblick' },
  { key: 'setup', label: 'Installation' },
  { key: 'auth', label: 'Auth & Benutzer' },
  { key: 'mcp', label: 'MCP-Tools' },
  { key: 'api', label: 'REST API' },
  { key: 'architecture', label: 'Architektur' },
];

export default function Docs() {
  const [active, setActive] = useState<DocsSection>('overview');

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
                    ? 'bg-gray-800 text-blue-400 font-medium'
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
                ? 'bg-gray-800 text-blue-400 font-medium'
                : 'text-gray-500'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-16 md:pb-0">
        <h1 className="text-2xl font-bold mb-8">Dokumentation</h1>

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
  return (
    <>
      <Section title="Was ist DevGrimoire?">
        <p className="text-gray-400 leading-relaxed">
          DevGrimoire gibt Claude (dem AI-Assistenten) ein persistentes
          Ged&auml;chtnis f&uuml;r deine Projekte. Claude kann Projekte tracken,
          Todos und Milestones verwalten, Arbeitssessions dokumentieren,
          Wissen abspeichern, Changelogs pflegen und verschl&uuml;sselte
          Secrets verwalten &mdash; alles &uuml;ber das{' '}
          <span className="text-gray-200">Model Context Protocol (MCP)</span>.
        </p>
        <p className="text-gray-400 leading-relaxed mt-3">
          Das Web-Frontend zeigt dir, was Claude gespeichert hat,
          und erm&ouml;glicht eigene Verwaltung: Projekte anlegen, Todos bearbeiten,
          Wissen durchsuchen und vieles mehr.
        </p>
      </Section>

      <Section title="Features">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FeatureCard title="Projekte & Todos" desc="Projekte mit Todos, Milestones, Dependencies und Status-Workflow" />
          <FeatureCard title="Wissensbasis" desc="Wissenseintr&auml;ge und Recherche mit Volltextsuche" />
          <FeatureCard title="Changelog" desc="Versionierte &Auml;nderungshistorie pro Projekt/Komponente" />
          <FeatureCard title="Sessions" desc="Arbeitssitzungen mit Zusammenfassung und n&auml;chsten Schritten" />
          <FeatureCard title="Secrets" desc="AES-256-GCM verschl&uuml;sselte Secrets und Umgebungsvariablen" />
          <FeatureCard title="Globale Suche" desc="Ctrl+K Suche &uuml;ber Todos, Wissen, Changelogs, Research, Milestones" />
          <FeatureCard title="Multi-User Auth" desc="JWT-basiert mit Rollen (Admin/User), Profilverwaltung, RBAC" />
          <FeatureCard title="Live-Updates" desc="SSE-basierte Echtzeit-Updates via MongoDB Change Streams" />
          <FeatureCard title="Benachrichtigungen" desc="In-App Inbox + optionale Web-Push-Notifications" />
          <FeatureCard title="MCP Remote" desc="HTTP/SSE-Zugriff von jedem Rechner im Netzwerk" />
        </div>
      </Section>

      <Section title="Voraussetzungen">
        <ul className="text-gray-400 space-y-1 list-disc list-inside">
          <li>Docker & Docker Compose</li>
          <li>Claude Code CLI oder Claude Desktop</li>
          <li>Node.js 22+ (nur f&uuml;r lokale MCP-Server Entwicklung)</li>
        </ul>
      </Section>
    </>
  );
}

function SetupSection() {
  return (
    <>
      <Section title="Installation">
        <Step n={1} title="Repository klonen & Umgebung konfigurieren">
          <Code>{`git clone <repo-url> DevGrimoire
cd DevGrimoire
cp .env.example .env
# .env anpassen`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            Wichtige Variablen in <Mono>.env</Mono>:
          </p>
          <div className="mt-2 space-y-1 text-sm text-gray-400">
            <EnvVar name="MONGO_ROOT_PASSWORD" desc="MongoDB-Passwort" />
            <EnvVar name="AUTH_USERNAME / AUTH_PASSWORD" desc="Initiales Admin-Konto (wird beim Start in DB angelegt)" />
            <EnvVar name="JWT_SECRET" desc="Geheimnis f&uuml;r JWT-Signierung" />
            <EnvVar name="SECRETS_ENCRYPTION_KEY" desc="AES-256-Key f&uuml;r Secrets (64 Hex-Zeichen)" />
          </div>
          <Code>{`# Encryption Key generieren:
openssl rand -hex 32`}</Code>
        </Step>

        <Step n={2} title="Docker Stack starten">
          <Code>{`docker compose up -d`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            Startet MongoDB (Replica Set), Backend (NestJS) und Frontend (nginx).
          </p>
        </Step>
      </Section>

      <Section title="Remote-Anbindung (HTTP/SSE)">
        <p className="text-gray-400 text-sm mb-4">
          Das Backend stellt HTTP-basierte MCP-Endpoints bereit. Claude Code kann von{' '}
          <strong className="text-gray-200">jedem Rechner im Netzwerk</strong>{' '}
          auf DevGrimoire zugreifen &mdash; ohne lokale Installation.
        </p>

        <Step n={1} title="Claude Code CLI">
          <p className="text-gray-400 text-sm mb-2">
            In <Mono>~/.claude.json</Mono>:
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
            Ben&ouml;tigt <Mono>mcp-remote</Mono> als Bridge (Node.js erforderlich).
            In <Mono>claude_desktop_config.json</Mono>:
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
            <code className="bg-gray-800 px-1 rounded">--allow-http</code> ist n&ouml;tig, da{' '}
            mcp-remote standardm&auml;&szlig;ig nur HTTPS erlaubt.
            Config-Pfade: macOS <Mono>~/Library/Application Support/Claude/claude_desktop_config.json</Mono>,
            Linux <Mono>~/.config/Claude/claude_desktop_config.json</Mono>
          </Hint>
        </Step>

        <Step n={3} title="Web-Frontend aufrufen">
          <p className="text-gray-400 text-sm">
            Das Dashboard ist unter <Mono>http://[server]</Mono> erreichbar (Port 80, nginx).
          </p>
        </Step>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mt-4">
          <p className="text-gray-300 text-sm font-medium mb-2">Verf&uuml;gbare MCP-Transports</p>
          <div className="space-y-2 text-sm text-gray-400">
            <div className="flex gap-3">
              <code className="text-green-400 shrink-0 w-44">GET /sse</code>
              <span>Legacy SSE (Claude Code, Claude Desktop)</span>
            </div>
            <div className="flex gap-3">
              <code className="text-green-400 shrink-0 w-44">POST /messages</code>
              <span>Legacy SSE Message-Endpoint</span>
            </div>
            <div className="flex gap-3">
              <code className="text-blue-400 shrink-0 w-44">POST|GET|DELETE /mcp</code>
              <span>Streamable HTTP (neuere Clients)</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Lokale Anbindung (stdio)">
        <p className="text-gray-400 text-sm mb-4">
          Alternativ kann der MCP-Server lokal per stdio gestartet werden.
          Node.js und MongoDB m&uuml;ssen erreichbar sein.
        </p>

        <Step n={1} title="Backend lokal bauen">
          <Code>{`cd backend
npm install
NODE_OPTIONS="--max-old-space-size=8192" npm run build`}</Code>
        </Step>

        <Step n={2} title="MCP-Config einrichten">
          <Code>{`{
  "mcpServers": {
    "devgrimoire": {
      "command": "node",
      "args": ["/pfad/zu/DevGrimoire/backend/dist/mcp-server.js"],
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
  return (
    <>
      <Section title="Authentifizierung">
        <p className="text-gray-400 text-sm mb-4">
          DevGrimoire unterst&uuml;tzt Multi-User-Authentifizierung mit rollenbasierter Zugriffskontrolle (RBAC).
          Beim ersten Start wird aus den Env-Variablen <Mono>AUTH_USERNAME</Mono> und <Mono>AUTH_PASSWORD</Mono> ein
          Admin-Benutzer in der Datenbank angelegt. Weitere Benutzer k&ouml;nnen &uuml;ber die Admin-Oberfl&auml;che
          verwaltet werden.
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Access Token" value="JWT, 15 Minuten g&uuml;ltig, im Speicher gehalten" />
          <InfoRow label="Refresh Token" value="Opak, 7 Tage g&uuml;ltig, MongoDB mit TTL, Token-Rotation" />
          <InfoRow label="SSE" value="Auth via ?token=... Query-Parameter (EventSource unterst&uuml;tzt keine Header)" />
          <InfoRow label="MCP Server" value="stdio = lokal ohne Auth; HTTP-Endpoints via API Key gesch&uuml;tzt" />
          <InfoRow label="API Keys" value={<>SHA-256 gehasht, Prefix <Mono>cv_</Mono>, Bearer Header oder <Mono>?apiKey=</Mono> Query</>} />
        </div>
        <Hint>
          Ohne gesetzte Credentials (<Mono>AUTH_USERNAME</Mono> / <Mono>AUTH_PASSWORD</Mono>) ist die
          Authentifizierung komplett deaktiviert &mdash; alle Endpunkte sind frei zug&auml;nglich.
        </Hint>
      </Section>

      <Section title="Rollen & Berechtigungen">
        <div className="space-y-3">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900 text-purple-300">Admin</span>
              <span className="text-sm text-gray-300 font-medium">Administrator</span>
            </div>
            <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
              <li>Voller Zugriff auf alle Funktionen</li>
              <li>Benutzerverwaltung (anlegen, bearbeiten, deaktivieren, l&ouml;schen)</li>
              <li>Erster Admin wird aus Env-Variablen beim Start angelegt</li>
            </ul>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">User</span>
              <span className="text-sm text-gray-300 font-medium">Benutzer</span>
            </div>
            <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
              <li>Lese-/Schreibzugriff auf Projekte, Todos, Wissen etc.</li>
              <li>Eigenes Profil bearbeiten und Passwort &auml;ndern</li>
              <li>Kein Zugriff auf Benutzerverwaltung</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section title="Benutzerverwaltung">
        <p className="text-gray-400 text-sm mb-3">
          Admins finden die Benutzerverwaltung unter <Mono>Einstellungen &rarr; Benutzerverwaltung</Mono>.
          Dort k&ouml;nnen Benutzer angelegt, bearbeitet, deaktiviert und gel&ouml;scht werden.
        </p>
        <p className="text-gray-400 text-sm">
          Jeder Benutzer kann unter <Mono>Profil</Mono> (Klick auf den Benutzernamen in der Topbar) seinen
          Benutzernamen, E-Mail und Passwort &auml;ndern.
        </p>
      </Section>

      <Section title="API Keys (MCP Auth)">
        <p className="text-gray-400 text-sm mb-4">
          API Keys erm&ouml;glichen authentifizierten Zugriff auf die MCP-Endpoints (<Mono>/mcp</Mono>, <Mono>/sse</Mono>, <Mono>/messages</Mono>)
          und die REST API. Keys werden SHA-256 gehasht gespeichert und k&ouml;nnen unter{' '}
          <Mono>Einstellungen &rarr; API Keys</Mono> verwaltet werden.
        </p>

        <Step n={1} title="API Key erstellen">
          <p className="text-gray-400 text-sm">
            Unter <Mono>Einstellungen &rarr; API Keys &rarr; Erstellen</Mono>. Der Plaintext-Key wird
            <strong className="text-gray-200"> nur einmalig</strong> angezeigt &mdash; sofort kopieren!
          </p>
        </Step>

        <Step n={2} title="MCP-Client konfigurieren">
          <p className="text-gray-400 text-sm mb-2">
            Claude Code (<Mono>~/.claude.json</Mono>):
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
            Alternativ per Header (Streamable HTTP):
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

        <Step n={3} title="REST API mit API Key">
          <p className="text-gray-400 text-sm mb-2">
            API Keys funktionieren auch f&uuml;r die REST API:
          </p>
          <Code>{`# Header
curl -H "Authorization: Bearer cv_..." http://[server]/api/projects

# Query Parameter
curl http://[server]/api/projects?apiKey=cv_...`}</Code>
        </Step>

        <div className="space-y-2 text-sm text-gray-400 mt-4">
          <InfoRow label="Prefix" value={<><Mono>cv_</Mono> + 64 Hex-Zeichen (32 Bytes random)</>} />
          <InfoRow label="Speicherung" value="Nur SHA-256 Hash in der Datenbank" />
          <InfoRow label="Ablauf" value="Optional, bei Erstellung konfigurierbar" />
          <InfoRow label="Scope" value="Gleiche Rechte wie User-Rolle" />
        </div>

        <Hint>
          Wenn Auth nicht aktiviert ist (keine <Mono>AUTH_USERNAME</Mono> / <Mono>AUTH_PASSWORD</Mono>),
          sind alle Endpoints inkl. MCP frei zug&auml;nglich &mdash; API Keys werden nicht ben&ouml;tigt.
        </Hint>
      </Section>

      <Section title="Secrets & Verschl&uuml;sselung">
        <p className="text-gray-400 text-sm mb-4">
          Secrets werden mit AES-256-GCM verschl&uuml;sselt in MongoDB gespeichert.
          Jedes Secret hat einen eigenen zuf&auml;lligen IV.
        </p>
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Algorithmus" value="AES-256-GCM (Authenticated Encryption)" />
          <InfoRow label="Key" value={<><Mono>SECRETS_ENCRYPTION_KEY</Mono> (64 Hex-Zeichen = 32 Bytes)</>} />
          <InfoRow label="Speicherformat" value={<><Mono>iv:authTag:ciphertext</Mono> (Hex)</>} />
          <InfoRow label="List-Endpoint" value="Gibt nur Keys + Beschreibung zur&uuml;ck, niemals Werte" />
          <InfoRow label="Entschl&uuml;sselung" value={<>Nur via <Mono>GET /api/secrets/:id</Mono> oder <Mono>secret_get</Mono></>} />
        </div>
        <Hint>
          Ohne gesetzten <Mono>SECRETS_ENCRYPTION_KEY</Mono> ist das
          Secrets-Feature deaktiviert.
        </Hint>
      </Section>
    </>
  );
}

function McpSection() {
  return (
    <>
      <Section title="MCP-Tools (49)">
        <p className="text-gray-400 text-sm mb-4">
          Nach dem Anbinden stehen Claude 49 Tools zur Verf&uuml;gung.
          List-Tools liefern kompakte &Uuml;bersichten, Details nur via _get Tools.
        </p>

        <ToolGroup title="Projekte" tools={[
          { name: 'project_create', desc: 'Neues Projekt anlegen' },
          { name: 'project_list', desc: 'Alle Projekte auflisten' },
          { name: 'project_get', desc: 'Projekt per ID oder Name abrufen' },
          { name: 'project_update', desc: 'Projekt aktualisieren' },
          { name: 'project_delete', desc: 'Projekt und alle Daten l\u00f6schen' },
        ]} />

        <ToolGroup title="Todos" tools={[
          { name: 'todo_create', desc: 'Todo anlegen (Status, Priorit\u00e4t, Tags, Milestone)' },
          { name: 'todo_list', desc: 'Todos filtern nach Projekt/Status/Priorit\u00e4t' },
          { name: 'todo_get', desc: 'Einzelnes Todo mit Details und Kommentaren' },
          { name: 'todo_update', desc: 'Status, Priorit\u00e4t, Dependencies \u00e4ndern' },
          { name: 'todo_delete', desc: 'Todo l\u00f6schen' },
          { name: 'todo_comment', desc: 'Kommentar an ein Todo anh\u00e4ngen' },
        ]} />

        <ToolGroup title="Milestones" tools={[
          { name: 'milestone_create', desc: 'Milestone/Epic anlegen' },
          { name: 'milestone_list', desc: 'Milestones eines Projekts auflisten' },
          { name: 'milestone_get', desc: 'Einzelnen Milestone abrufen' },
          { name: 'milestone_update', desc: 'Milestone aktualisieren' },
          { name: 'milestone_delete', desc: 'Milestone l\u00f6schen' },
        ]} />

        <ToolGroup title="Sessions" tools={[
          { name: 'session_save', desc: 'Arbeitssession speichern (Zusammenfassung, Dateien, n\u00e4chste Schritte)' },
          { name: 'session_get', desc: 'Letzte Session(s) eines Projekts abrufen' },
        ]} />

        <ToolGroup title="Wissen" tools={[
          { name: 'knowledge_save', desc: 'Wissenseintrag speichern (Architektur, Patterns, Notizen)' },
          { name: 'knowledge_search', desc: 'Volltextsuche in der Wissensbasis' },
          { name: 'knowledge_list', desc: 'Alle Eintr\u00e4ge eines Projekts auflisten' },
          { name: 'knowledge_get', desc: 'Einzelnen Wissenseintrag mit vollem Inhalt' },
          { name: 'knowledge_update', desc: 'Eintrag aktualisieren' },
          { name: 'knowledge_delete', desc: 'Eintrag l\u00f6schen' },
        ]} />

        <ToolGroup title="Changelog" tools={[
          { name: 'changelog_add', desc: 'Eintrag hinzuf\u00fcgen (Version, Changes, Component)' },
          { name: 'changelog_list', desc: 'Changelog eines Projekts auflisten' },
          { name: 'changelog_get', desc: 'Einzelnen Eintrag abrufen' },
          { name: 'changelog_update', desc: 'Eintrag aktualisieren' },
          { name: 'changelog_delete', desc: 'Eintrag l\u00f6schen' },
        ]} />

        <ToolGroup title="Handbuch" tools={[
          { name: 'manual_save', desc: 'Projekthandbuch speichern/aktualisieren (Markdown)' },
          { name: 'manual_get', desc: 'Projekthandbuch abrufen' },
        ]} />

        <ToolGroup title="Recherche" tools={[
          { name: 'research_save', desc: 'Recherche-Eintrag speichern (Quellen, Erkenntnisse)' },
          { name: 'research_search', desc: 'Volltextsuche in Recherche-Eintr\u00e4gen' },
          { name: 'research_list', desc: 'Eintr\u00e4ge eines Projekts auflisten' },
          { name: 'research_get', desc: 'Einzelnen Eintrag abrufen' },
          { name: 'research_update', desc: 'Eintrag aktualisieren' },
          { name: 'research_delete', desc: 'Eintrag l\u00f6schen' },
        ]} />

        <ToolGroup title="Umgebungen & Secrets" tools={[
          { name: 'environment_create', desc: 'Umgebung anlegen (dev, staging, prod) mit Variablen' },
          { name: 'environment_list', desc: 'Umgebungen eines Projekts auflisten' },
          { name: 'environment_get', desc: 'Einzelne Umgebung mit Variablen' },
          { name: 'environment_update', desc: 'Umgebung aktualisieren' },
          { name: 'environment_delete', desc: 'Umgebung l\u00f6schen' },
          { name: 'environment_export', desc: 'Variablen + Secrets als .env exportieren' },
          { name: 'secret_set', desc: 'Secret anlegen/aktualisieren (AES-256-GCM)' },
          { name: 'secret_get', desc: 'Secret entschl\u00fcsselt abrufen' },
          { name: 'secret_list', desc: 'Secrets auflisten (nur Keys, keine Werte)' },
          { name: 'secret_delete', desc: 'Secret l\u00f6schen' },
        ]} />

        <ToolGroup title="Sonstiges" tools={[
          { name: 'notify_user', desc: 'Benachrichtigung an den User senden' },
          { name: 'system_instructions_get', desc: 'Globale Agent-Instruktionen abrufen' },
          { name: 'system_instructions_set', desc: 'Globale Agent-Instruktionen setzen' },
        ]} />
      </Section>
    </>
  );
}

function ApiSection() {
  return (
    <>
      <Section title="REST API">
        <p className="text-gray-400 text-sm mb-4">
          Das Backend stellt eine REST API unter <Mono>/api</Mono> bereit.
          Bei aktivierter Auth ben&ouml;tigen alle Endpunkte (au&szlig;er <Mono>/api/auth/*</Mono>) einen
          g&uuml;ltigen JWT Bearer Token. Endpunkte mit <span className="text-purple-400">(Admin)</span> erfordern die Admin-Rolle.
        </p>
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="pb-2 pr-4">Methode</th>
                <th className="pb-2 pr-4">Endpunkt</th>
                <th className="pb-2">Beschreibung</th>
              </tr>
            </thead>
            <tbody className="text-gray-400">
              <EndpointGroup label="Auth & Benutzer" endpoints={[
                { method: 'POST', path: '/api/auth/login', desc: 'Login (Username + Password)' },
                { method: 'POST', path: '/api/auth/refresh', desc: 'Token erneuern' },
                { method: 'POST', path: '/api/auth/logout', desc: 'Logout (Refresh Token l\u00f6schen)' },
                { method: 'GET', path: '/api/auth/status', desc: 'Auth-Status pr\u00fcfen' },
                { method: 'GET', path: '/api/auth/profile', desc: 'Eigenes Profil abrufen' },
                { method: 'PATCH', path: '/api/auth/profile', desc: 'Profil aktualisieren (Username, E-Mail)' },
                { method: 'POST', path: '/api/auth/change-password', desc: 'Passwort \u00e4ndern' },
                { method: 'GET', path: '/api/users', desc: 'Alle Benutzer (Admin)' },
                { method: 'POST', path: '/api/users', desc: 'Benutzer anlegen (Admin)' },
                { method: 'PATCH', path: '/api/users/:id', desc: 'Benutzer bearbeiten (Admin)' },
                { method: 'DELETE', path: '/api/users/:id', desc: 'Benutzer l\u00f6schen (Admin)' },
              ]} />
              <EndpointGroup label="API Keys" endpoints={[
                { method: 'GET', path: '/api/api-keys', desc: 'Eigene API Keys auflisten' },
                { method: 'POST', path: '/api/api-keys', desc: 'Neuen API Key erstellen (Plaintext einmalig in Response)' },
                { method: 'DELETE', path: '/api/api-keys/:id', desc: 'API Key widerrufen' },
              ]} />
              <EndpointGroup label="Projekte" endpoints={[
                { method: 'GET', path: '/api/projects?active=&favorite=', desc: 'Projekte auflisten (Filter)' },
                { method: 'POST', path: '/api/projects', desc: 'Projekt anlegen' },
                { method: 'GET', path: '/api/projects/:id', desc: 'Einzelnes Projekt' },
                { method: 'PUT', path: '/api/projects/:id', desc: 'Projekt aktualisieren' },
                { method: 'DELETE', path: '/api/projects/:id', desc: 'Projekt l\u00f6schen' },
              ]} />
              <EndpointGroup label="Todos" endpoints={[
                { method: 'GET', path: '/api/todos?projectId=&status=', desc: 'Todos filtern (Status kommasepariert)' },
                { method: 'POST', path: '/api/todos', desc: 'Todo anlegen' },
                { method: 'GET', path: '/api/todos/:id', desc: 'Einzelnes Todo' },
                { method: 'PUT', path: '/api/todos/:id', desc: 'Todo aktualisieren' },
                { method: 'DELETE', path: '/api/todos/:id', desc: 'Todo l\u00f6schen' },
                { method: 'POST', path: '/api/todos/:id/comments', desc: 'Kommentar hinzuf\u00fcgen' },
              ]} />
              <EndpointGroup label="Milestones" endpoints={[
                { method: 'GET', path: '/api/milestones?projectId=', desc: 'Milestones auflisten' },
                { method: 'POST', path: '/api/milestones', desc: 'Milestone anlegen' },
                { method: 'GET', path: '/api/milestones/:id', desc: 'Einzelner Milestone' },
                { method: 'PUT', path: '/api/milestones/:id', desc: 'Milestone aktualisieren' },
                { method: 'DELETE', path: '/api/milestones/:id', desc: 'Milestone l\u00f6schen' },
              ]} />
              <EndpointGroup label="Sessions" endpoints={[
                { method: 'GET', path: '/api/sessions?projectId=', desc: 'Sessions abrufen' },
                { method: 'GET', path: '/api/sessions/latest/:projectId', desc: 'Letzte Session' },
                { method: 'POST', path: '/api/sessions', desc: 'Session speichern' },
              ]} />
              <EndpointGroup label="Wissen" endpoints={[
                { method: 'GET', path: '/api/knowledge?projectId=', desc: 'Wissen abrufen' },
                { method: 'GET', path: '/api/knowledge/search?q=&projectId=', desc: 'Wissen suchen' },
                { method: 'POST', path: '/api/knowledge', desc: 'Wissen speichern' },
                { method: 'PUT', path: '/api/knowledge/:id', desc: 'Wissen aktualisieren' },
                { method: 'DELETE', path: '/api/knowledge/:id', desc: 'Wissen l\u00f6schen' },
              ]} />
              <EndpointGroup label="Changelog" endpoints={[
                { method: 'GET', path: '/api/changelog?projectId=', desc: 'Changelog auflisten' },
                { method: 'POST', path: '/api/changelog', desc: 'Eintrag anlegen' },
                { method: 'DELETE', path: '/api/changelog/:id', desc: 'Eintrag l\u00f6schen' },
              ]} />
              <EndpointGroup label="Umgebungen & Secrets" endpoints={[
                { method: 'GET', path: '/api/environments?projectId=', desc: 'Umgebungen auflisten' },
                { method: 'POST', path: '/api/environments', desc: 'Umgebung anlegen' },
                { method: 'GET', path: '/api/environments/:id', desc: 'Einzelne Umgebung' },
                { method: 'PUT', path: '/api/environments/:id', desc: 'Umgebung aktualisieren' },
                { method: 'DELETE', path: '/api/environments/:id', desc: 'Umgebung l\u00f6schen' },
                { method: 'GET', path: '/api/secrets?projectId=&environmentId=', desc: 'Secrets (ohne Werte)' },
                { method: 'POST', path: '/api/secrets', desc: 'Secret anlegen' },
                { method: 'GET', path: '/api/secrets/:id', desc: 'Secret entschl\u00fcsselt' },
                { method: 'PUT', path: '/api/secrets/:id', desc: 'Secret aktualisieren' },
                { method: 'DELETE', path: '/api/secrets/:id', desc: 'Secret l\u00f6schen' },
              ]} />
              <EndpointGroup label="Sonstiges" endpoints={[
                { method: 'GET', path: '/api/search?q=&projectId=&limit=', desc: 'Globale Suche' },
                { method: 'GET', path: '/api/activities?projectId=', desc: 'Aktivit\u00e4ten' },
                { method: 'GET', path: '/api/notifications', desc: 'Benachrichtigungen' },
                { method: 'GET', path: '/api/events/:projectId', desc: 'SSE Live-Updates' },
                { method: 'GET', path: '/api/settings/:key', desc: 'Einstellung lesen' },
                { method: 'PUT', path: '/api/settings/:key', desc: 'Einstellung setzen' },
              ]} />
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function ArchitectureSection() {
  return (
    <>
      <Section title="Architektur">
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

      <Section title="Module">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <ModuleItem name="projects" desc="Projektverwaltung" />
          <ModuleItem name="todos" desc="Tasks mit Status-Workflow" />
          <ModuleItem name="milestones" desc="Feature-Milestones/Epics" />
          <ModuleItem name="sessions" desc="Arbeitssitzungen" />
          <ModuleItem name="knowledge" desc="Wissensbasis" />
          <ModuleItem name="changelog" desc="Versions-Changelog" />
          <ModuleItem name="environments" desc="Umgebungsvariablen" />
          <ModuleItem name="secrets" desc="Verschl&uuml;sselte Secrets" />
          <ModuleItem name="auth" desc="JWT Auth + RBAC + User CRUD" />
          <ModuleItem name="api-keys" desc="API Key Auth (SHA-256)" />
          <ModuleItem name="search" desc="Globale Suche" />
          <ModuleItem name="activities" desc="Activity Feed" />
          <ModuleItem name="notifications" desc="In-App Benachrichtigungen" />
          <ModuleItem name="push" desc="Web Push (VAPID)" />
          <ModuleItem name="events" desc="SSE Live-Updates" />
          <ModuleItem name="settings" desc="Key-Value Einstellungen" />
          <ModuleItem name="common" desc="Shared Pipes, EncryptionService" />
        </div>
      </Section>

      <Section title="Technologie-Stack">
        <div className="space-y-2 text-sm text-gray-400">
          <InfoRow label="Backend" value="NestJS, Mongoose, MongoDB (Replica Set)" />
          <InfoRow label="Frontend" value="React, Vite, TailwindCSS" />
          <InfoRow label="MCP" value="@modelcontextprotocol/sdk (stdio + HTTP/SSE)" />
          <InfoRow label="Auth" value="Passport JWT, bcrypt, Token-Rotation" />
          <InfoRow label="Verschl&uuml;sselung" value="AES-256-GCM (Node.js crypto)" />
          <InfoRow label="Infrastruktur" value="Docker Compose (MongoDB, Backend, nginx)" />
          <InfoRow label="Live-Updates" value="MongoDB Change Streams + SSE" />
        </div>
      </Section>
    </>
  );
}

/* ─── Shared Components ─── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-blue-400 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-medium text-gray-300 mb-2">
        <span className="text-blue-400 mr-2">{n}.</span>
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
