# ClaudeVault

**Persistentes Projektgedaechtnis fuer Claude** -- MCP-Server, REST API und React-Dashboard in einem.

ClaudeVault gibt Claude (dem AI-Assistenten) ein persistentes Gedaechtnis fuer deine Projekte. Claude kann Projekte tracken, Todos verwalten, Arbeitssessions dokumentieren und Wissen abspeichern -- alles ueber das [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Das Web-Frontend zeigt dir, was Claude gespeichert hat.

## Architektur

```
┌──────────────┐     stdio      ┌─────────────────────────────────┐
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
                                └─────────────────────────────────┘
```

## Features

- **17 MCP-Tools** -- Claude kann Projekte, Todos, Sessions und Wissen direkt verwalten
- **REST API** -- Vollstaendige CRUD-API fuer alle Ressourcen
- **React-Dashboard** -- Dark-Mode UI mit Projekt-Uebersicht, Kanban-Board fuer Todos, Session-Historie und Wissensbasis
- **Zwei MCP-Transports** -- Lokaler stdio-Modus oder Remote via HTTP/SSE
- **Docker Compose** -- Ein Befehl fuer den kompletten Stack

## MCP-Tools

| Bereich | Tools | Beschreibung |
|---------|-------|--------------|
| **Projekte** | `project_create`, `project_list`, `project_get`, `project_update`, `project_delete` | Projekte anlegen, abrufen, aktualisieren, loeschen |
| **Todos** | `todo_create`, `todo_list`, `todo_update`, `todo_delete`, `todo_comment` | Aufgaben mit Status (open/in_progress/review/done), Prioritaet und Tags |
| **Sessions** | `session_save`, `session_get` | Arbeitssessions dokumentieren (Zusammenfassung, geaenderte Dateien, naechste Schritte) |
| **Wissen** | `knowledge_save`, `knowledge_search`, `knowledge_list`, `knowledge_update`, `knowledge_delete` | Wissensbasis mit Volltextsuche |

## Voraussetzungen

- **Docker & Docker Compose** (fuer den kompletten Stack)
- **Node.js 22+** (nur fuer lokale MCP-Server Entwicklung)
- **Claude Code CLI** oder **Claude Desktop** (als MCP-Client)

## Schnellstart mit Docker Compose

```bash
# 1. Repository klonen
git clone https://github.com/Gonrum/ClaudeVault.git
cd ClaudeVault

# 2. Umgebungsvariablen konfigurieren
cp .env.example .env
# .env anpassen (MongoDB Passwort aendern!)

# 3. Stack starten
docker compose up -d
```

Danach ist verfuegbar:

| Dienst | URL |
|--------|-----|
| Frontend (Dashboard) | http://localhost:5173 |
| Backend (REST API) | http://localhost:3200/api |
| MCP SSE-Endpoint | http://localhost:3200/sse |
| MCP Streamable HTTP | http://localhost:3200/mcp |
| MongoDB | localhost:27017 |

## Entwicklung (ohne Docker)

### Backend

```bash
cd backend
npm install
NODE_OPTIONS="--max-old-space-size=8192" npm run build
npm run start:dev    # REST API mit Hot-Reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev          # Vite Dev-Server
```

### MCP-Server (stdio)

```bash
cd backend
npm run start:mcp    # Startet den MCP-Server via stdio
```

## MCP-Konfiguration

### Remote-Anbindung (HTTP/SSE -- empfohlen)

Wenn der Docker Stack laeuft, kann Claude von jedem Rechner im Netzwerk auf ClaudeVault zugreifen -- ohne lokale Installation, ohne Node.js, ohne MongoDB-Zugriff.

In `~/.claude.json` (Claude Code) oder `claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "claudevault": {
      "type": "sse",
      "url": "http://<hostname>:3200/sse"
    }
  }
}
```

Ersetze `<hostname>` durch den Hostnamen oder die IP des Servers.

### Verfuegbare MCP-Transports

| Endpoint | Beschreibung |
|----------|--------------|
| `GET /sse` | Legacy SSE (Claude Code, Claude Desktop) |
| `POST /messages` | Legacy SSE Message-Endpoint |
| `POST\|GET\|DELETE /mcp` | Streamable HTTP (neuere Clients) |

### Lokale Anbindung (stdio)

Alternativ kann der MCP-Server lokal per stdio gestartet werden. Dafuer muss das Backend lokal gebaut sein und MongoDB erreichbar sein.

```bash
cd backend
npm install
NODE_OPTIONS="--max-old-space-size=8192" npm run build
```

In `~/.claude.json`:

```json
{
  "mcpServers": {
    "claudevault": {
      "command": "node",
      "args": ["/pfad/zu/ClaudeVault/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/claudevault?authSource=admin"
      }
    }
  }
}
```

Danach Claude Code neu starten, damit der MCP-Server geladen wird.

> **Hinweis:** Die MCP-Endpoints haben aktuell keine Authentifizierung. In einer Produktionsumgebung sollte der Zugriff per Firewall oder VPN eingeschraenkt werden.

## REST API

| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| `GET` | `/api/projects` | Alle Projekte |
| `POST` | `/api/projects` | Projekt anlegen |
| `GET` | `/api/projects/:id` | Einzelnes Projekt |
| `PUT` | `/api/projects/:id` | Projekt aktualisieren |
| `DELETE` | `/api/projects/:id` | Projekt loeschen |
| `GET` | `/api/todos?projectId=&status=` | Todos filtern |
| `POST` | `/api/todos` | Todo anlegen |
| `PUT` | `/api/todos/:id` | Todo aktualisieren |
| `DELETE` | `/api/todos/:id` | Todo loeschen |
| `GET` | `/api/sessions?projectId=` | Sessions abrufen |
| `GET` | `/api/sessions/latest/:projectId` | Letzte Session |
| `POST` | `/api/sessions` | Session speichern |
| `GET` | `/api/knowledge?projectId=` | Wissen abrufen |
| `GET` | `/api/knowledge/search?q=&projectId=` | Wissen suchen |
| `POST` | `/api/knowledge` | Wissen speichern |
| `PUT` | `/api/knowledge/:id` | Wissen aktualisieren |
| `DELETE` | `/api/knowledge/:id` | Wissen loeschen |

## Tech Stack

| Komponente | Technologie |
|------------|-------------|
| Backend | NestJS 11, Mongoose 8, TypeScript 5 |
| Frontend | React 19, Vite 6, TailwindCSS 3, React Router 7 |
| Datenbank | MongoDB 7 |
| MCP | @modelcontextprotocol/sdk 1.12 |
| Infrastruktur | Docker Compose, nginx |

## Projektstruktur

```
ClaudeVault/
├── backend/
│   └── src/
│       ├── main.ts              # REST API Entry (NestJS HTTP, Prefix /api)
│       ├── mcp-server.ts        # MCP Entry (stdio Transport)
│       ├── mcp-tools.ts         # MCP Tool-Definitionen (17 Tools)
│       ├── projects/            # Projekt-Modul (Schema, Service, Controller, DTOs)
│       ├── todos/               # Todo-Modul
│       ├── sessions/            # Session-Modul
│       └── knowledge/           # Wissens-Modul
├── frontend/
│   └── src/
│       ├── pages/               # Dashboard, Projekte, Todos, Sessions, Wissen, Docs
│       └── components/          # Wiederverwendbare UI-Komponenten
├── docker-compose.yml
├── .env.example
└── README.md
```

## Lizenz

MIT
