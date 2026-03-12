# DevGrimoire

**Persistentes Projektgedaechtnis fuer Claude** -- MCP-Server, REST API und React-Dashboard in einem.

DevGrimoire gibt Claude (dem AI-Assistenten) ein persistentes Gedaechtnis fuer deine Projekte. Ueber das [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) kann Claude Projekte verwalten, Aufgaben und Milestones tracken, Wissen speichern, Changelogs pflegen, Datenbank-Schemas dokumentieren, Abhaengigkeiten scannen, Feature-Kataloge fuehren, Handbuecher schreiben und vieles mehr. Das Web-Frontend zeigt alles in einem Dark-Mode Dashboard mit Echtzeit-Updates.

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

- **70 MCP-Tools** -- Claude kann Projekte, Todos, Milestones, Sessions, Wissen, Changelogs, Handbuecher, Recherchen, Schemas, Abhaengigkeiten, Features, Umgebungen und Secrets verwalten
- **REST API** -- 98 Endpoints fuer alle Ressourcen
- **React-Dashboard** -- Dark-Mode UI mit Kanban-Board, Milestone-Tracking, Activity Feed, Markdown-Editor und mehr
- **Echtzeit-Updates** -- SSE via MongoDB Change Streams + EventEmitter
- **Authentifizierung** -- Multi-User JWT-Auth mit Rollen (Admin/User), API-Keys fuer programmatischen Zugriff
- **Verschluesselte Secrets** -- AES-256-GCM pro Umgebung (dev/staging/prod)
- **Push-Benachrichtigungen** -- Claude kann den User via Web Push benachrichtigen
- **Globale Suche** -- Volltextsuche ueber alle Entitaeten eines Projekts
- **Projekt-Import/Export** -- Kompletten Projektstand als JSON exportieren und importieren
- **In-App Benachrichtigungen** -- Notification-Inbox mit Deep-Links
- **ARM/Standalone-Modus** -- Laeuft auch auf Raspberry Pi und anderen ARM-Geraeten
- **Zwei MCP-Transports** -- Lokaler stdio-Modus oder Remote via HTTP/SSE
- **Docker Compose** -- Ein Befehl fuer den kompletten Stack

## MCP-Tools (70)

| Bereich | Tools | Beschreibung |
|---------|-------|--------------|
| **Projekte** | `project_create`, `_list`, `_get`, `_update`, `_delete` | Container fuer alle Daten, Tech Stack, Instruktionen |
| **Todos** | `todo_create`, `_list`, `_get`, `_update`, `_delete`, `_comment` | Status-State-Machine, Prioritaet, Tags, Dependencies, Archivierung |
| **Milestones** | `milestone_create`, `_list`, `_get`, `_update`, `_delete` | Gruppierung von Todos, Abschluss erfordert Changelog |
| **Sessions** | `session_save`, `_get` | Arbeitssessions mit Zusammenfassung, Dateien, naechsten Schritten |
| **Wissen** | `knowledge_save`, `_search`, `_list`, `_get`, `_update`, `_delete` | Langfristige Wissensbasis mit Volltextsuche |
| **Changelog** | `changelog_add`, `_list`, `_get`, `_update`, `_delete` | Versions-Changelog mit Component-Support |
| **Handbuecher** | `manual_create`, `_list`, `_get`, `_update`, `_delete` | Kategorisierte Dokumentation in Markdown |
| **Recherche** | `research_save`, `_search`, `_list`, `_get`, `_update`, `_delete` | Zeitpunktbezogene Recherchen mit Quellen |
| **Schemas** | `schema_create`, `_list`, `_get`, `_update`, `_delete`, `_versions` | DB-Schema-Dokumentation mit Versionierung |
| **Features** | `feature_create`, `_list`, `_get`, `_update`, `_delete` | Feature-Katalog mit Status-Tracking |
| **Dependencies** | `dependency_add`, `_list`, `_get`, `_update`, `_delete`, `_scan` | Paketabhaengigkeiten mit Bulk-Scan aus package.json etc. |
| **Umgebungen** | `environment_create`, `_list`, `_get`, `_update`, `_delete`, `_export` | Key-Value Variablen pro Environment, .env-Export |
| **Secrets** | `secret_set`, `_get`, `_list`, `_delete` | AES-256-GCM verschluesselte Werte |
| **System** | `system_instructions_get`, `_set`, `notify_user` | Agent-Instruktionen, Push-Benachrichtigungen |

## Schnellstart

### Voraussetzungen

- **Docker & Docker Compose**
- **Claude Code CLI** oder **Claude Desktop** (als MCP-Client)

### Installation

```bash
# 1. Repository klonen
git clone https://github.com/Gonrum/DevGrimoire.git
cd DevGrimoire

# 2. Umgebungsvariablen konfigurieren
cp .env.example .env
# .env anpassen (MongoDB Credentials, Auth, Encryption Key)

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

### ARM/Standalone-Modus

Fuer ARM-Geraete (Raspberry Pi, Jetson Nano) oder Systeme mit wenig RAM:

```bash
docker compose -f docker-compose.yml -f docker-compose.standalone.yml up -d
```

Dies startet MongoDB ohne Replica Set (weniger RAM, kein Change Stream, SSE trotzdem funktional via EventEmitter).

## Konfiguration

Umgebungsvariablen in `.env`:

| Variable | Beschreibung | Erforderlich |
|----------|--------------|:------------:|
| `MONGO_USER` | MongoDB-Benutzername | Ja |
| `MONGO_PASSWORD` | MongoDB-Passwort | Ja |
| `MONGODB_URI` | Volle MongoDB Connection URI | Ja |
| `AUTH_USERNAME` | Login-Benutzername (erster Admin) | Nein* |
| `AUTH_PASSWORD` | Login-Passwort | Nein* |
| `JWT_SECRET` | Geheimnis fuer JWT-Signierung | Bei Auth |
| `SECRETS_ENCRYPTION_KEY` | AES-256-Key (64 Hex-Zeichen) | Fuer Secrets |
| `VAPID_PUBLIC_KEY` | Web Push Public Key | Fuer Push |
| `VAPID_PRIVATE_KEY` | Web Push Private Key | Fuer Push |
| `MONGODB_STANDALONE` | `true` fuer Standalone-Modus | Nein |
| `NODE_HEAP_SIZE` | Node.js Heap in MB (Default: 512) | Nein |

\* Ohne `AUTH_USERNAME`/`AUTH_PASSWORD` ist die Authentifizierung deaktiviert.

```bash
# Encryption Key generieren:
openssl rand -hex 32
```

## MCP-Konfiguration

### Remote-Anbindung (HTTP/SSE -- empfohlen)

Wenn der Docker Stack laeuft, kann Claude von jedem Rechner im Netzwerk auf DevGrimoire zugreifen -- ohne lokale Installation.

In `~/.claude.json` (Claude Code) oder `claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "devgrimoire": {
      "type": "sse",
      "url": "http://<hostname>:3200/sse"
    }
  }
}
```

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
    "devgrimoire": {
      "command": "node",
      "args": ["/pfad/zu/DevGrimoire/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/devgrimoire?authSource=admin&directConnection=true"
      }
    }
  }
}
```

> **Hinweis:** Die MCP-Endpoints haben aktuell keine Authentifizierung. In einer Produktionsumgebung sollte der Zugriff per Firewall oder VPN eingeschraenkt werden.

## Authentifizierung

DevGrimoire unterstuetzt Multi-User-Authentifizierung mit Rollen:

- **Rollen** -- `admin` (voller Zugriff + Benutzerverwaltung), `user` (Lese-/Schreibzugriff)
- **Access Token** -- JWT, 15 Minuten gueltig, im Speicher gehalten
- **Refresh Token** -- Opak, 7 Tage gueltig, in MongoDB mit TTL-Index, Rotation bei Nutzung
- **API-Keys** -- Fuer programmatischen Zugriff (z.B. CI/CD), beschraenkbar auf Rollen
- **SSE** -- Auth via `?token=...` Query-Parameter (EventSource unterstuetzt keine Header)
- **MCP Server** -- Nicht geschuetzt (stdio = nur lokal, HTTP/SSE = ggf. Firewall/VPN)

Beim ersten Start wird aus `AUTH_USERNAME`/`AUTH_PASSWORD` ein Admin-Account erstellt. Weitere User koennen im Dashboard unter Benutzerverwaltung angelegt werden.

## Secrets & Verschluesselung

Secrets werden mit AES-256-GCM verschluesselt in MongoDB gespeichert:

- Jedes Secret hat einen eigenen zufaelligen IV
- Speicherformat: `iv:authTag:ciphertext` (alles Hex)
- List-Endpoint gibt nur Keys + Beschreibung zurueck, niemals Werte
- Entschluesselung nur via `GET /api/secrets/:id` oder `secret_get` MCP-Tool
- Ohne `SECRETS_ENCRYPTION_KEY` ist das Secrets-Feature deaktiviert

## Projekt-Import/Export

Komplette Projektdaten (Todos, Milestones, Wissen, Changelog, Sessions, Schemas, Dependencies, Features, Handbuecher, Recherchen, Umgebungen, Secrets) koennen als JSON exportiert und in eine neue Instanz importiert werden. Dabei werden alle internen Referenzen (Milestone-Links, Dependencies, Changelog-Verknuepfungen) korrekt remapped.

- **Export**: Projekteinstellungen > Daten-Export (optional mit entschluesselten Secret-Werten)
- **Import**: Projektuebersicht > JSON importieren

## Tech Stack

| Komponente | Technologie |
|------------|-------------|
| Backend | NestJS 11, Mongoose 8, TypeScript 5, Passport JWT |
| Frontend | React 19, Vite 6, TailwindCSS 3, React Router 7 |
| Datenbank | MongoDB 7 (Replica Set oder Standalone) |
| MCP | @modelcontextprotocol/sdk 1.12 |
| Sicherheit | bcryptjs, AES-256-GCM, JWT (Access + Refresh), API-Keys |
| Infrastruktur | Docker Compose, nginx, Multi-Arch (x86_64 + ARM64) |

## Projektstruktur

```
DevGrimoire/
├── backend/
│   └── src/
│       ├── main.ts                # REST API Entry (NestJS HTTP, Prefix /api)
│       ├── mcp-server.ts          # MCP Entry (stdio Transport)
│       ├── mcp-tools.ts           # MCP Tool-Definitionen (70 Tools)
│       ├── auth/                  # JWT Auth, Rollen, API-Keys, User-Verwaltung
│       ├── projects/              # Projekte (Schema, Service, Controller, DTOs)
│       ├── todos/                 # Aufgaben (State Machine, Dependencies, Comments)
│       ├── milestones/            # Milestones (Changelog-Verknuepfung)
│       ├── sessions/              # Arbeitssessions
│       ├── knowledge/             # Wissensbasis (Volltextsuche)
│       ├── changelog/             # Versions-Changelog
│       ├── manuals/               # Kategorisierte Handbuecher
│       ├── research/              # Recherchen mit Quellen
│       ├── schemas/               # DB-Schema-Dokumentation (Versionierung)
│       ├── features/              # Feature-Katalog
│       ├── dependencies/          # Paketabhaengigkeiten (Scan)
│       ├── environments/          # Umgebungsvariablen (dev/staging/prod)
│       ├── secrets/               # Verschluesselte Secrets (AES-256-GCM)
│       ├── activities/            # Activity Feed (automatisch geloggt)
│       ├── notifications/         # In-App Benachrichtigungen
│       ├── events/                # SSE Events (Change Streams + EventEmitter)
│       ├── push/                  # Web Push (VAPID)
│       ├── search/                # Globale Suche
│       ├── settings/              # System-Einstellungen
│       ├── api-keys/              # API-Key Verwaltung
│       ├── counters/              # Auto-Increment Nummern (T-1, M-1)
│       ├── project-transfer/      # JSON Import/Export
│       └── common/                # Shared (Encryption, Pipes, Interceptors)
├── frontend/
│   └── src/
│       ├── pages/                 # Dashboard, Projektdetail, Todo-Detail, Login, ...
│       ├── components/            # TodoBoard, MilestoneList, SchemaList, ManualView, ...
│       ├── components/ui/         # Button, Badge, ConfirmButton, EmptyState, ...
│       └── hooks/                 # useAuth, useProjectEvents
├── docker-compose.yml             # Standard (Replica Set)
├── docker-compose.standalone.yml  # ARM/Standalone (ohne Replica Set)
├── .env.example
├── CLAUDE.md                      # Instruktionen fuer Claude Code
└── README.md
```

## Lizenz

MIT
