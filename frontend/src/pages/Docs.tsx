export default function Docs() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-8">Dokumentation</h1>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          Was ist ClaudeVault?
        </h2>
        <p className="text-gray-400 leading-relaxed">
          ClaudeVault gibt Claude (dem AI-Assistenten) ein persistentes
          Gedächtnis für deine Projekte. Claude kann Projekte tracken,
          Todos verwalten, Arbeitssessions dokumentieren und Wissen
          abspeichern &mdash; alles über das{' '}
          <span className="text-gray-200">Model Context Protocol (MCP)</span>.
          Dieses Web-Frontend zeigt dir, was Claude gespeichert hat.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          Voraussetzungen
        </h2>
        <ul className="text-gray-400 space-y-1 list-disc list-inside">
          <li>Docker & Docker Compose</li>
          <li>Claude Code CLI (oder Claude Desktop)</li>
          <li>Node.js 22+ (nur für lokale MCP-Server Entwicklung)</li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          Installation
        </h2>

        <Step n={1} title="Repository klonen & Umgebung konfigurieren">
          <Code>{`git clone <repo-url> ClaudeVault
cd ClaudeVault
cp .env.example .env
# .env anpassen (MongoDB Passwort ändern)`}</Code>
        </Step>

        <Step n={2} title="Docker Stack starten">
          <Code>{`docker compose up -d`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            Startet MongoDB, Backend (REST API) und Frontend (nginx).
          </p>
        </Step>

        <Step n={3} title="Backend lokal bauen (für MCP-Server)">
          <Code>{`cd backend
npm install
NODE_OPTIONS="--max-old-space-size=8192" npm run build`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            Der MCP-Server läuft lokal via stdio, nicht im Docker Container.
          </p>
        </Step>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          MCP-Server anbinden
        </h2>

        <h3 className="text-sm font-medium text-gray-300 mt-4 mb-2">
          Claude Code CLI
        </h3>
        <p className="text-gray-400 text-sm mb-2">
          Füge folgendes in <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">~/.claude.json</code> ein:
        </p>
        <Code>{`{
  "mcpServers": {
    "claudevault": {
      "command": "node",
      "args": ["/pfad/zu/ClaudeVault/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/claudevault?authSource=admin"
      }
    }
  }
}`}</Code>
        <p className="text-gray-500 text-sm mt-2">
          Danach Claude Code neu starten, damit der MCP-Server geladen wird.
        </p>

        <h3 className="text-sm font-medium text-gray-300 mt-6 mb-2">
          Claude Desktop App
        </h3>
        <p className="text-gray-400 text-sm mb-2">
          Füge folgendes in{' '}
          <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">
            claude_desktop_config.json
          </code>{' '}
          ein:
        </p>
        <Code>{`{
  "mcpServers": {
    "claudevault": {
      "command": "node",
      "args": ["/pfad/zu/ClaudeVault/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/claudevault?authSource=admin"
      }
    }
  }
}`}</Code>
        <p className="text-gray-500 text-sm mt-2">
          Pfad zur Config: macOS{' '}
          <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">
            ~/Library/Application Support/Claude/claude_desktop_config.json
          </code>
          , Linux{' '}
          <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">
            ~/.config/Claude/claude_desktop_config.json
          </code>
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          Verfügbare MCP-Tools
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          Nach dem Anbinden stehen Claude 16 Tools zur Verfügung:
        </p>

        <ToolGroup title="Projekte" tools={[
          { name: 'project_create', desc: 'Neues Projekt anlegen' },
          { name: 'project_list', desc: 'Alle Projekte auflisten' },
          { name: 'project_get', desc: 'Projekt per ID oder Name abrufen' },
          { name: 'project_update', desc: 'Projekt aktualisieren' },
          { name: 'project_delete', desc: 'Projekt und alle Daten löschen' },
        ]} />

        <ToolGroup title="Todos" tools={[
          { name: 'todo_create', desc: 'Neues Todo anlegen (Status, Priorität, Tags)' },
          { name: 'todo_list', desc: 'Todos filtern nach Projekt/Status' },
          { name: 'todo_update', desc: 'Todo-Status oder Priorität ändern' },
          { name: 'todo_delete', desc: 'Todo löschen' },
        ]} />

        <ToolGroup title="Sessions" tools={[
          { name: 'session_save', desc: 'Arbeitssession speichern (Zusammenfassung, Dateien, nächste Schritte)' },
          { name: 'session_get', desc: 'Letzte Session(s) eines Projekts abrufen' },
        ]} />

        <ToolGroup title="Wissen" tools={[
          { name: 'knowledge_save', desc: 'Wissenseintrag speichern (Architektur, Patterns, Notizen)' },
          { name: 'knowledge_search', desc: 'Volltextsuche in der Wissensbasis' },
          { name: 'knowledge_list', desc: 'Alle Einträge eines Projekts auflisten' },
          { name: 'knowledge_update', desc: 'Eintrag aktualisieren' },
          { name: 'knowledge_delete', desc: 'Eintrag löschen' },
        ]} />
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          Remote-Anbindung (HTTP/SSE &mdash; empfohlen)
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          Das Backend stellt neben dem lokalen stdio-Transport auch einen
          HTTP-basierten MCP-Endpoint bereit. So kann Claude Code von{' '}
          <strong className="text-gray-200">jedem Rechner im Netzwerk</strong>{' '}
          auf ClaudeVault zugreifen &mdash; ohne lokale Installation, ohne Node.js,
          ohne MongoDB-Zugriff.
        </p>

        <Step n={1} title="Docker Stack auf dem Server starten">
          <Code>{`docker compose up -d`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            Auf dem Rechner, der ClaudeVault hostet (z.B.{' '}
            <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">jetson</code>).
          </p>
        </Step>

        <Step n={2} title="MCP-Config auf dem Client-Rechner">
          <p className="text-gray-400 text-sm mb-2">
            In <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">~/.claude.json</code> oder{' '}
            <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">claude_desktop_config.json</code>:
          </p>
          <Code>{`{
  "mcpServers": {
    "claudevault": {
      "type": "sse",
      "url": "http://jetson:3200/sse"
    }
  }
}`}</Code>
          <p className="text-gray-500 text-sm mt-2">
            Ersetze <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">jetson</code> durch
            den Hostnamen oder die IP des Servers. Das ist alles &mdash; kein Node.js,
            kein Klonen des Repos nötig.
          </p>
        </Step>

        <Step n={3} title="Web-Frontend aufrufen">
          <p className="text-gray-400 text-sm">
            Das Dashboard ist unter{' '}
            <code className="text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded">
              http://jetson:5173
            </code>{' '}
            erreichbar.
          </p>
        </Step>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mt-4">
          <p className="text-gray-300 text-sm font-medium mb-2">Verfügbare MCP-Transports</p>
          <div className="space-y-2 text-sm text-gray-400">
            <div className="flex gap-3">
              <code className="text-green-400 shrink-0 w-40">GET /sse</code>
              <span>Legacy SSE (Claude Code, Claude Desktop)</span>
            </div>
            <div className="flex gap-3">
              <code className="text-green-400 shrink-0 w-40">POST /messages</code>
              <span>Legacy SSE Message-Endpoint</span>
            </div>
            <div className="flex gap-3">
              <code className="text-blue-400 shrink-0 w-40">POST|GET|DELETE /mcp</code>
              <span>Streamable HTTP (neuere Clients)</span>
            </div>
          </div>
        </div>

        <div className="bg-yellow-900/20 border border-yellow-800/50 rounded-lg p-4 mt-4">
          <p className="text-yellow-400 text-sm font-medium mb-1">Sicherheit</p>
          <p className="text-yellow-400/80 text-sm">
            Die MCP-Endpoints haben aktuell keine Authentifizierung. In einer
            Produktionsumgebung sollte der Zugriff per Firewall oder VPN
            eingeschränkt werden.
          </p>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          Lokale Anbindung (stdio)
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          Alternativ kann der MCP-Server lokal per stdio gestartet werden.
          Dann wird Node.js auf dem Rechner benötigt und die MongoDB muss erreichbar sein.
        </p>

        <Step n={1} title="Backend lokal bauen">
          <Code>{`cd backend
npm install
NODE_OPTIONS="--max-old-space-size=8192" npm run build`}</Code>
        </Step>

        <Step n={2} title="MCP-Config einrichten">
          <Code>{`{
  "mcpServers": {
    "claudevault": {
      "command": "node",
      "args": ["/pfad/zu/ClaudeVault/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/claudevault?authSource=admin"
      }
    }
  }
}`}</Code>
        </Step>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          REST API
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          Das Backend stellt auch eine REST API bereit, die vom Frontend genutzt wird:
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
              <Endpoint method="GET" path="/api/projects" desc="Alle Projekte" />
              <Endpoint method="POST" path="/api/projects" desc="Projekt anlegen" />
              <Endpoint method="GET" path="/api/projects/:id" desc="Einzelnes Projekt" />
              <Endpoint method="PUT" path="/api/projects/:id" desc="Projekt aktualisieren" />
              <Endpoint method="DELETE" path="/api/projects/:id" desc="Projekt löschen" />
              <Endpoint method="GET" path="/api/todos?projectId=&status=" desc="Todos filtern" />
              <Endpoint method="POST" path="/api/todos" desc="Todo anlegen" />
              <Endpoint method="PUT" path="/api/todos/:id" desc="Todo aktualisieren" />
              <Endpoint method="DELETE" path="/api/todos/:id" desc="Todo löschen" />
              <Endpoint method="GET" path="/api/sessions?projectId=" desc="Sessions abrufen" />
              <Endpoint method="GET" path="/api/sessions/latest/:projectId" desc="Letzte Session" />
              <Endpoint method="POST" path="/api/sessions" desc="Session speichern" />
              <Endpoint method="GET" path="/api/knowledge?projectId=" desc="Wissen abrufen" />
              <Endpoint method="GET" path="/api/knowledge/search?q=&projectId=" desc="Wissen suchen" />
              <Endpoint method="POST" path="/api/knowledge" desc="Wissen speichern" />
              <Endpoint method="PUT" path="/api/knowledge/:id" desc="Wissen aktualisieren" />
              <Endpoint method="DELETE" path="/api/knowledge/:id" desc="Wissen löschen" />
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-blue-400 mb-3">
          Architektur
        </h2>
        <Code>{`┌──────────────┐     stdio      ┌─────────────────────────────────┐
│ Claude (lokal)│◄──────────────►│  mcp-server.ts (stdio entry)    │
└──────────────┘                │         │                        │
                                │         ▼                        │
┌──────────────┐  HTTP/SSE      │  ┌─────────────┐                │
│Claude (remote)│◄──────────────►│  │  mcp-tools  │  (shared)     │
└──────────────┘  /sse + /mcp   │  └──────┬──────┘                │
                                │         ▼                        │
┌──────────────┐   REST /api    │  ┌───────────┐  ┌───────────┐  │  ┌─────────┐
│ React Frontend│◄──────────────►│  │ Controller│──►│  Services │────►│ MongoDB │
└──────────────┘   via nginx    │  └───────────┘  └───────────┘  │  └─────────┘
                                │                                 │
                                │         NestJS Backend           │
                                └─────────────────────────────────┘`}</Code>
      </section>
    </div>
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

function Endpoint({ method, path, desc }: { method: string; path: string; desc: string }) {
  const color = method === 'GET' ? 'text-green-400' : method === 'POST' ? 'text-blue-400' : method === 'PUT' ? 'text-yellow-400' : 'text-red-400';
  return (
    <tr className="border-b border-gray-800/50">
      <td className={`py-1.5 pr-4 font-mono text-xs ${color}`}>{method}</td>
      <td className="py-1.5 pr-4 font-mono text-xs text-gray-300">{path}</td>
      <td className="py-1.5 text-gray-500">{desc}</td>
    </tr>
  );
}
