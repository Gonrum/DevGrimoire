# DevGrimoire

**Persistent project memory for Claude** -- MCP server, REST API, and React dashboard in one.

> **Note:** This project was built entirely via vibe coding with Claude. While it works well in practice, the code has not been manually audited for security. **Do not expose it to the public internet without proper review.** Use it in trusted networks or behind a VPN.

DevGrimoire gives Claude (the AI assistant) a persistent memory for your projects. Through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), Claude can manage projects, track tasks and milestones, store knowledge, maintain changelogs, document database schemas, scan dependencies, manage feature catalogs, write manuals, and much more. The web frontend displays everything in a dark-mode dashboard with real-time updates.

## Architecture

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

- **70 MCP Tools** -- Claude can manage projects, todos, milestones, sessions, knowledge, changelogs, manuals, research, schemas, dependencies, features, environments, and secrets
- **REST API** -- 98 endpoints for all resources
- **React Dashboard** -- Dark-mode UI with Kanban board, milestone tracking, activity feed, Markdown editor, and more
- **Real-Time Updates** -- SSE via MongoDB Change Streams + EventEmitter
- **Authentication** -- Multi-user JWT auth with roles (Admin/User), API keys for programmatic access
- **Encrypted Secrets** -- AES-256-GCM per environment (dev/staging/prod)
- **Push Notifications** -- Claude can notify the user via Web Push
- **Global Search** -- Full-text search across all entities of a project
- **Project Import/Export** -- Export and import complete project state as JSON
- **In-App Notifications** -- Notification inbox with deep links
- **ARM/Standalone Mode** -- Runs on Raspberry Pi and other ARM devices
- **Two MCP Transports** -- Local stdio mode or remote via HTTP/SSE
- **Docker Compose** -- One command for the entire stack

## MCP Tools (70)

| Area | Tools | Description |
|------|-------|-------------|
| **Projects** | `project_create`, `_list`, `_get`, `_update`, `_delete` | Container for all data, tech stack, instructions |
| **Todos** | `todo_create`, `_list`, `_get`, `_update`, `_delete`, `_comment` | Status state machine, priority, tags, dependencies, archiving |
| **Milestones** | `milestone_create`, `_list`, `_get`, `_update`, `_delete` | Grouping of todos, completion requires changelog |
| **Sessions** | `session_save`, `_get` | Work sessions with summary, files, next steps |
| **Knowledge** | `knowledge_save`, `_search`, `_list`, `_get`, `_update`, `_delete` | Long-term knowledge base with full-text search |
| **Changelog** | `changelog_add`, `_list`, `_get`, `_update`, `_delete` | Version changelog with component support |
| **Manuals** | `manual_create`, `_list`, `_get`, `_update`, `_delete` | Categorized documentation in Markdown |
| **Research** | `research_save`, `_search`, `_list`, `_get`, `_update`, `_delete` | Point-in-time research with sources |
| **Schemas** | `schema_create`, `_list`, `_get`, `_update`, `_delete`, `_versions` | DB schema documentation with versioning |
| **Features** | `feature_create`, `_list`, `_get`, `_update`, `_delete` | Feature catalog with status tracking |
| **Dependencies** | `dependency_add`, `_list`, `_get`, `_update`, `_delete`, `_scan` | Package dependencies with bulk scan from package.json etc. |
| **Environments** | `environment_create`, `_list`, `_get`, `_update`, `_delete`, `_export` | Key-value variables per environment, .env export |
| **Secrets** | `secret_set`, `_get`, `_list`, `_delete` | AES-256-GCM encrypted values |
| **System** | `system_instructions_get`, `_set`, `notify_user` | Agent instructions, push notifications |

## Quick Start

### Prerequisites

- **Docker & Docker Compose**
- **Claude Code CLI** or **Claude Desktop** (as MCP client)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/Gonrum/DevGrimoire.git
cd DevGrimoire

# 2. Configure environment variables
cp .env.example .env
# Edit .env (MongoDB credentials, auth, encryption key)

# 3. Start the stack
docker compose up -d
```

Once running, the following services are available:

| Service | URL |
|---------|-----|
| Frontend (Dashboard) | http://localhost |
| Backend (REST API) | http://localhost:3200/api |
| MCP SSE Endpoint | http://localhost:3200/sse |
| MCP Streamable HTTP | http://localhost:3200/mcp |

### ARM/Standalone Mode

For ARM devices (Raspberry Pi, Jetson Nano) or systems with limited RAM:

```bash
docker compose -f docker-compose.yml -f docker-compose.standalone.yml up -d
```

This starts MongoDB without a replica set (less RAM, no Change Streams, but SSE still works via EventEmitter).

## Configuration

Environment variables in `.env`:

| Variable | Description | Required |
|----------|-------------|:--------:|
| `MONGO_USER` | MongoDB username | Yes |
| `MONGO_PASSWORD` | MongoDB password | Yes |
| `MONGODB_URI` | Full MongoDB connection URI | Yes |
| `AUTH_USERNAME` | Login username (first admin) | No* |
| `AUTH_PASSWORD` | Login password | No* |
| `JWT_SECRET` | Secret for JWT signing | With Auth |
| `SECRETS_ENCRYPTION_KEY` | AES-256 key (64 hex characters) | For Secrets |
| `VAPID_PUBLIC_KEY` | Web Push public key | For Push |
| `VAPID_PRIVATE_KEY` | Web Push private key | For Push |
| `MONGODB_STANDALONE` | `true` for standalone mode | No |
| `NODE_HEAP_SIZE` | Node.js heap in MB (default: 512) | No |

\* Without `AUTH_USERNAME`/`AUTH_PASSWORD`, authentication is disabled.

```bash
# Generate encryption key:
openssl rand -hex 32
```

## MCP Configuration

### Remote Connection (HTTP/SSE -- recommended)

When the Docker stack is running, Claude can access DevGrimoire from any machine on the network -- no local installation required.

In `~/.claude.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop):

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

### Available MCP Transports

| Endpoint | Description |
|----------|-------------|
| `GET /sse` | Legacy SSE (Claude Code, Claude Desktop) |
| `POST /messages` | Legacy SSE message endpoint |
| `POST\|GET\|DELETE /mcp` | Streamable HTTP (newer clients) |

### Local Connection (stdio)

Alternatively, the MCP server can be started locally via stdio. This requires the backend to be built locally and MongoDB to be reachable.

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
      "args": ["/path/to/DevGrimoire/backend/dist/mcp-server.js"],
      "env": {
        "MONGODB_URI": "mongodb://user:pass@localhost:27017/devgrimoire?authSource=admin&directConnection=true"
      }
    }
  }
}
```

> **Note:** The MCP endpoints currently have no authentication. In a production environment, access should be restricted via firewall or VPN.

## Authentication

DevGrimoire supports multi-user authentication with roles:

- **Roles** -- `admin` (full access + user management), `user` (read/write access)
- **Access Token** -- JWT, valid for 15 minutes, held in memory
- **Refresh Token** -- Opaque, valid for 7 days, stored in MongoDB with TTL index, rotated on use
- **API Keys** -- For programmatic access (e.g., CI/CD), restrictable to roles
- **SSE** -- Auth via `?token=...` query parameter (EventSource does not support headers)
- **MCP Server** -- Not protected (stdio = local only, HTTP/SSE = use firewall/VPN as needed)

On first startup, an admin account is created from `AUTH_USERNAME`/`AUTH_PASSWORD`. Additional users can be created in the dashboard under user management.

## Secrets & Encryption

Secrets are stored AES-256-GCM encrypted in MongoDB:

- Each secret has its own random IV
- Storage format: `iv:authTag:ciphertext` (all hex)
- List endpoint returns only keys + description, never values
- Decryption only via `GET /api/secrets/:id` or `secret_get` MCP tool
- Without `SECRETS_ENCRYPTION_KEY`, the secrets feature is disabled

## Project Import/Export

Complete project data (todos, milestones, knowledge, changelog, sessions, schemas, dependencies, features, manuals, research, environments, secrets) can be exported as JSON and imported into a new instance. All internal references (milestone links, dependencies, changelog associations) are correctly remapped.

- **Export**: Project settings > Data export (optionally with decrypted secret values)
- **Import**: Project overview > Import JSON

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | NestJS 11, Mongoose 8, TypeScript 5, Passport JWT |
| Frontend | React 19, Vite 6, TailwindCSS 3, React Router 7 |
| Database | MongoDB 7 (Replica Set or Standalone) |
| MCP | @modelcontextprotocol/sdk 1.12 |
| Security | bcryptjs, AES-256-GCM, JWT (Access + Refresh), API Keys |
| Infrastructure | Docker Compose, nginx, Multi-Arch (x86_64 + ARM64) |

## Project Structure

```
DevGrimoire/
├── backend/
│   └── src/
│       ├── main.ts                # REST API entry (NestJS HTTP, prefix /api)
│       ├── mcp-server.ts          # MCP entry (stdio transport)
│       ├── mcp-tools.ts           # MCP tool definitions (70 tools)
│       ├── auth/                  # JWT auth, roles, API keys, user management
│       ├── projects/              # Projects (schema, service, controller, DTOs)
│       ├── todos/                 # Tasks (state machine, dependencies, comments)
│       ├── milestones/            # Milestones (changelog association)
│       ├── sessions/              # Work sessions
│       ├── knowledge/             # Knowledge base (full-text search)
│       ├── changelog/             # Version changelog
│       ├── manuals/               # Categorized manuals
│       ├── research/              # Research with sources
│       ├── schemas/               # DB schema documentation (versioning)
│       ├── features/              # Feature catalog
│       ├── dependencies/          # Package dependencies (scan)
│       ├── environments/          # Environment variables (dev/staging/prod)
│       ├── secrets/               # Encrypted secrets (AES-256-GCM)
│       ├── activities/            # Activity feed (auto-logged)
│       ├── notifications/         # In-app notifications
│       ├── events/                # SSE events (Change Streams + EventEmitter)
│       ├── push/                  # Web Push (VAPID)
│       ├── search/                # Global search
│       ├── settings/              # System settings
│       ├── api-keys/              # API key management
│       ├── counters/              # Auto-increment numbers (T-1, M-1)
│       ├── project-transfer/      # JSON import/export
│       └── common/                # Shared (encryption, pipes, interceptors)
├── frontend/
│   └── src/
│       ├── pages/                 # Dashboard, project detail, todo detail, login, ...
│       ├── components/            # TodoBoard, MilestoneList, SchemaList, ManualView, ...
│       ├── components/ui/         # Button, Badge, ConfirmButton, EmptyState, ...
│       └── hooks/                 # useAuth, useProjectEvents
├── docker-compose.yml             # Standard (replica set)
├── docker-compose.standalone.yml  # ARM/Standalone (without replica set)
├── .env.example
├── CLAUDE.md                      # Instructions for Claude Code
└── README.md
```

## License

[AGPL-3.0](LICENSE) -- You are free to use, self-host, and modify DevGrimoire. If you operate a modified version as a service, you must publish the source code.
