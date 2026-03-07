# ClaudeVault

**Persistentes Projektgedaechtnis fuer Claude** -- MCP-Server, REST API und React-Dashboard in einem.

ClaudeVault gibt Claude (dem AI-Assistenten) ein persistentes Gedaechtnis fuer deine Projekte. Claude kann Projekte tracken, Todos und Milestones verwalten, Arbeitssessions dokumentieren, Wissen abspeichern, Changelogs pflegen, Umgebungen konfigurieren und verschluesselte Secrets verwalten -- alles ueber das [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Das Web-Frontend zeigt dir, was Claude gespeichert hat, und ermoeglicht eigene Verwaltung.

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

Module: projects, todos, milestones, sessions, knowledge, changelog,
        environments, secrets, activities, auth, push, events
```

## Features

- **27 MCP-Tools** -- Claude kann Projekte, Todos, Milestones, Sessions, Wissen, Changelogs, Umgebungen und Secrets verwalten
- **REST API** -- Vollstaendige CRUD-API fuer alle Ressourcen
- **React-Dashboard** -- Dark-Mode UI mit Kanban-Board, Milestone-Tracking, Activity Feed und mehr
- **Authentifizierung** -- Optionale Single-User JWT-Auth (Access + Refresh Token)
- **Verschluesselte Secrets** -- AES-256-GCM Verschluesselung fuer Passwoerter und API-Keys
- **Umgebungsverwaltung** -- Dev/Staging/Prod Umgebungen mit Variablen und Secrets
- **Live-Updates** -- SSE via MongoDB Change Streams fuer Echtzeit-Aenderungen im Frontend
- **Push-Benachrichtigungen** -- Claude kann den User via Web Push benachrichtigen
- **Zwei MCP-Transports** -- Lokaler stdio-Modus oder Remote via HTTP/SSE
- **Docker Compose** -- Ein Befehl fuer den kompletten Stack

## MCP-Tools

| Bereich | Tools | Beschreibung |
|---------|-------|--------------|
| **Projekte** | `project_create`, `project_list`, `project_get`, `project_update`, `project_delete` | Projekte anlegen, abrufen, aktualisieren, loeschen |
| **Todos** | `todo_create`, `todo_list`, `todo_update`, `todo_delete`, `todo_comment` | Aufgaben mit Status-State-Machine, Prioritaet, Tags, Dependencies |
| **Milestones** | `milestone_create`, `milestone_list`, `milestone_get`, `milestone_update`, `milestone_delete` | Feature-Milestones zum Gruppieren von Todos |
| **Sessions** | `session_save`, `session_get` | Arbeitssessions dokumentieren (Zusammenfassung, Dateien, naechste Schritte) |
| **Wissen** | `knowledge_save`, `knowledge_search`, `knowledge_list`, `knowledge_update`, `knowledge_delete` | Wissensbasis mit Volltextsuche |
| **Changelog** | `changelog_add`, `changelog_list`, `changelog_update`, `changelog_delete` | Versions-Changelog mit Component-Support |
| **Umgebungen** | `environment_create`, `environment_list`, `environment_get`, `environment_update`, `environment_delete` | Projekt-Umgebungen (dev, staging, prod) mit Key-Value Variablen |
| **Secrets** | `secret_set`, `secret_get`, `secret_list`, `secret_delete`, `environment_export` | AES-256-GCM verschluesselte Secrets, .env-Export |
| **Sonstiges** | `notify_user` | Push-Benachrichtigung an den User senden |

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
# .env anpassen (siehe Konfiguration)

# 3. Stack starten
docker compose up -d
```

Danach ist verfuegbar:

| Dienst | URL |
|--------|-----|
| Frontend (Dashboard) | http://localhost |
| Backend (REST API) | http://localhost:3200/api |
| MCP SSE-Endpoint | http://localhost:3200/sse |
| MCP Streamable HTTP | http://localhost:3200/mcp |

## Konfiguration

Wichtige Umgebungsvariablen in `.env`:

| Variable | Beschreibung | Erforderlich |
|----------|--------------|:------------:|
| `MONGO_ROOT_PASSWORD` | MongoDB-Passwort | Ja |
| `AUTH_USERNAME` | Login-Benutzername | Nein* |
| `AUTH_PASSWORD` | Login-Passwort | Nein* |
| `JWT_SECRET` | Geheimnis fuer JWT-Signierung | Bei Auth |
| `SECRETS_ENCRYPTION_KEY` | AES-256-Key (64 Hex-Zeichen) | Fuer Secrets |
| `VAPID_PUBLIC_KEY` | Web Push Public Key | Fuer Push |
| `VAPID_PRIVATE_KEY` | Web Push Private Key | Fuer Push |

\* Ohne `AUTH_USERNAME`/`AUTH_PASSWORD` ist die Authentifizierung deaktiviert.

```bash
# Encryption Key generieren:
openssl rand -hex 32
```

## Authentifizierung

ClaudeVault unterstuetzt optionale Single-User-Authentifizierung:

- **Access Token** -- JWT, 15 Minuten gueltig, im Speicher gehalten
- **Refresh Token** -- Opak, 7 Tage gueltig, in MongoDB mit TTL-Index, Rotation bei Nutzung
- **SSE** -- Auth via `?token=...` Query-Parameter (EventSource unterstuetzt keine Header)
- **MCP Server** -- Nicht geschuetzt (stdio, nur lokal)

Wenn `AUTH_USERNAME` und `AUTH_PASSWORD` gesetzt sind, werden alle REST-API-Endpoints geschuetzt (ausser `/api/auth/*`).

## Secrets & Verschluesselung

Secrets werden mit AES-256-GCM verschluesselt in MongoDB gespeichert:

- Jedes Secret hat einen eigenen zufaelligen IV
- Speicherformat: `iv:authTag:ciphertext` (alles Hex)
- List-Endpoint gibt nur Keys + Beschreibung zurueck, niemals Werte
- Entschluesselung nur via `GET /api/secrets/:id` oder `secret_get` MCP-Tool
- Ohne `SECRETS_ENCRYPTION_KEY` ist das Secrets-Feature deaktiviert

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
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/claudevault?authSource=admin&directConnection=true"
      }
    }
  }
}
```

Danach Claude Code neu starten, damit der MCP-Server geladen wird.

> **Hinweis:** Die MCP-Endpoints haben aktuell keine Authentifizierung. In einer Produktionsumgebung sollte der Zugriff per Firewall oder VPN eingeschraenkt werden.

## REST API

Bei aktivierter Auth benoetigen alle Endpoints (ausser `/api/auth/*`) einen gueltigen JWT Bearer Token.

| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| `POST` | `/api/auth/login` | Login (Username + Password) |
| `POST` | `/api/auth/refresh` | Token erneuern |
| `POST` | `/api/auth/logout` | Logout (Refresh Token loeschen) |
| `GET` | `/api/auth/status` | Auth-Status pruefen |
| `GET` | `/api/projects` | Alle Projekte |
| `POST` | `/api/projects` | Projekt anlegen |
| `GET` | `/api/projects/:id` | Einzelnes Projekt |
| `PUT` | `/api/projects/:id` | Projekt aktualisieren |
| `DELETE` | `/api/projects/:id` | Projekt loeschen |
| `GET` | `/api/todos?projectId=&status=` | Todos filtern |
| `POST` | `/api/todos` | Todo anlegen |
| `GET` | `/api/todos/:id` | Einzelnes Todo |
| `PUT` | `/api/todos/:id` | Todo aktualisieren |
| `DELETE` | `/api/todos/:id` | Todo loeschen |
| `POST` | `/api/todos/:id/comments` | Kommentar hinzufuegen |
| `GET` | `/api/milestones?projectId=` | Milestones auflisten |
| `POST` | `/api/milestones` | Milestone anlegen |
| `GET` | `/api/milestones/:id` | Einzelner Milestone |
| `PUT` | `/api/milestones/:id` | Milestone aktualisieren |
| `DELETE` | `/api/milestones/:id` | Milestone loeschen |
| `GET` | `/api/sessions?projectId=` | Sessions abrufen |
| `GET` | `/api/sessions/latest/:projectId` | Letzte Session |
| `POST` | `/api/sessions` | Session speichern |
| `GET` | `/api/knowledge?projectId=` | Wissen abrufen |
| `GET` | `/api/knowledge/search?q=&projectId=` | Wissen suchen |
| `POST` | `/api/knowledge` | Wissen speichern |
| `PUT` | `/api/knowledge/:id` | Wissen aktualisieren |
| `DELETE` | `/api/knowledge/:id` | Wissen loeschen |
| `GET` | `/api/changelog?projectId=` | Changelog auflisten |
| `POST` | `/api/changelog` | Changelog-Eintrag anlegen |
| `PUT` | `/api/changelog/:id` | Changelog-Eintrag aktualisieren |
| `DELETE` | `/api/changelog/:id` | Changelog-Eintrag loeschen |
| `GET` | `/api/environments?projectId=` | Umgebungen auflisten |
| `POST` | `/api/environments` | Umgebung anlegen |
| `GET` | `/api/environments/:id` | Einzelne Umgebung |
| `PUT` | `/api/environments/:id` | Umgebung aktualisieren |
| `DELETE` | `/api/environments/:id` | Umgebung loeschen |
| `GET` | `/api/secrets?projectId=&environmentId=` | Secrets auflisten (ohne Werte) |
| `POST` | `/api/secrets` | Secret anlegen |
| `GET` | `/api/secrets/:id` | Secret entschluesselt abrufen |
| `PUT` | `/api/secrets/:id` | Secret aktualisieren |
| `DELETE` | `/api/secrets/:id` | Secret loeschen |
| `GET` | `/api/activities?projectId=` | Aktivitaeten auflisten |
| `GET` | `/api/events/:projectId` | SSE Live-Updates |

## Tech Stack

| Komponente | Technologie |
|------------|-------------|
| Backend | NestJS 11, Mongoose 8, TypeScript 5, Passport JWT |
| Frontend | React 19, Vite 6, TailwindCSS 3, React Router 7 |
| Datenbank | MongoDB 7 (Replica Set fuer Change Streams) |
| MCP | @modelcontextprotocol/sdk 1.12 |
| Sicherheit | bcrypt, AES-256-GCM, JWT (Access + Refresh) |
| Infrastruktur | Docker Compose, nginx |

## Projektstruktur

```
ClaudeVault/
├── backend/
│   └── src/
│       ├── main.ts              # REST API Entry (NestJS HTTP, Prefix /api)
│       ├── mcp-server.ts        # MCP Entry (stdio Transport)
│       ├── mcp-tools.ts         # MCP Tool-Definitionen (27 Tools)
│       ├── auth/                # JWT Authentifizierung (Passport, Guards, Tokens)
│       ├── projects/            # Projekt-Modul (Schema, Service, Controller, DTOs)
│       ├── todos/               # Todo-Modul (State Machine, Dependencies, Comments)
│       ├── milestones/          # Milestone-Modul
│       ├── sessions/            # Session-Modul
│       ├── knowledge/           # Wissens-Modul (Volltextsuche)
│       ├── changelog/           # Changelog-Modul
│       ├── environments/        # Umgebungen-Modul (dev, staging, prod)
│       ├── secrets/             # Secrets-Modul (AES-256-GCM)
│       ├── activities/          # Aktivitaeten-Modul (automatisch geloggt)
│       ├── events/              # SSE Events (Change Streams + EventEmitter)
│       ├── push/                # Web Push Notifications (VAPID)
│       └── common/              # Shared (EncryptionService, ValidateProjectIdPipe)
├── frontend/
│   └── src/
│       ├── pages/               # Dashboard, Projektdetail, Todo-Detail, Login, Docs
│       ├── components/          # TodoBoard, MilestoneList, EnvironmentList, etc.
│       └── hooks/               # useAuth, useProjectEvents
├── docker-compose.yml
├── .env.example
├── CLAUDE.md
└── README.md
```

## Lizenz

MIT
