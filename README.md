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

- **126 MCP Tools** -- Claude can manage projects, todos, milestones, sessions, knowledge, changelogs, manuals, research, schemas, dependencies, features, snippets, environments, secrets, releases, logs, attachments, commits, recurring tasks, workspaces, web search, chat sessions, and more
- **Project Chat** -- In-dashboard chat with multi-provider LLM support (LM Studio, OpenAI-compatible, Anthropic, OpenAI), per-tool allowlist with read/write split, text + image attachments, vision models, audit logging
- **RAG Semantic Search** -- LanceDB vector database with Ollama/LM Studio embeddings for meaning-based search across indexed content entities
- **Distributed Sync** -- Master/Slave for backup setups, **Peer mode for bidirectional sync** with last-write-wins; per-project opt-in keeps personal projects local while sharing only what you choose
- **File Attachments** -- MinIO/S3-compatible storage for arbitrary files per project or per todo, automatic text extraction (incl. PDF) for RAG indexing
- **Releases** -- Per-project release tracking with assets, GitLab sync, draft/published/archived workflow
- **Structured Logs** -- Per-project log entries with TTL-based retention, search and stats; powers chat-tool audit trail
- **REST API** -- 100+ endpoints for all resources
- **React Dashboard** -- Dark-mode UI with Kanban board, milestone tracking, activity feed, Markdown editor, and more
- **Real-Time Updates** -- SSE via MongoDB Change Streams + EventEmitter
- **Authentication** -- Multi-user JWT auth with roles (Admin/User), API keys for programmatic access
- **Encrypted Secrets** -- AES-256-GCM per environment (dev/staging/prod); same encryption protects per-endpoint chat API keys and replication credentials
- **Push Notifications** -- Claude can notify the user via Web Push
- **Global Search** -- Full-text search across all entities of a project
- **Project Import/Export** -- Export and import complete project state as JSON
- **In-App Notifications** -- Notification inbox with deep links
- **ARM/Standalone Mode** -- Runs on Raspberry Pi and other ARM devices
- **Two MCP Transports** -- Local stdio mode or remote via HTTP/SSE
- **Docker Compose** -- One command for the entire stack

## Documentation

The README is the quick-start entry point. Detailed operational and integration docs live in [`docs/`](docs/):

- [Setup](docs/setup.md) -- installation, required environment variables, Docker profiles, ports
- [Security](docs/security.md) -- auth modes, API keys, MCP transport auth, secrets
- [GitHub Copilot Cloud Agent MCP Preset](docs/copilot-cloud-agent-mcp.md) -- scoped MCP config with `COPILOT_MCP_...` secrets and safe tool allowlists
- [MCP Apps Security and Audit Model](docs/mcp-apps-security.md) -- sandbox, CSP, scope, fallback, and audit rules for future `ui://` resources
- [MCP Tools](docs/mcp-tools.md) -- current tool groups and maintenance notes
- [UI Guidelines](docs/ui.md) -- frontend component usage and layout conventions
- [Workspaces](docs/workspaces.md) -- workspace sidecar, network model, `workspace_*` tools
- [Web Search](docs/web-search.md) -- SearXNG-backed `web_search` and `web_fetch`
- [Operations](docs/operations.md) -- volumes, backup/restore, updates, runtime notes

## MCP Tools (126)

| Area | Tools | Description |
|------|-------|-------------|
| **Projects** | `project_create`, `_list`, `_get`, `_update`, `_delete` | Container for all data, tech stack, instructions |
| **Todos** | `todo_create`, `_list`, `_get`, `_update`, `_delete`, `_comment` | Status state machine, priority, tags, dependencies, archiving |
| **Milestones** | `milestone_create`, `_list`, `_get`, `_update`, `_delete` | Grouping of todos, completion requires changelog |
| **Sessions** | `session_save`, `_get` | Work sessions with summary, files, next steps |
| **Knowledge** | `knowledge_save`, `_search`, `_list`, `_get`, `_update`, `_delete` | Long-term knowledge base with full-text search; supports project-scoped + global entries |
| **Changelog** | `changelog_add`, `_list`, `_get`, `_update`, `_delete` | Version changelog with component support |
| **Manuals** | `manual_create`, `_list`, `_get`, `_update`, `_delete` | Categorized documentation in Markdown |
| **Research** | `research_save`, `_search`, `_list`, `_get`, `_update`, `_delete` | Point-in-time research with sources |
| **Schemas** | `schema_create`, `_list`, `_get`, `_update`, `_delete`, `_versions` | DB schema documentation with versioning |
| **Features** | `feature_create`, `_list`, `_get`, `_update`, `_delete` | Feature catalog with status tracking |
| **Snippets** | `snippet_save`, `_list`, `_get`, `_update`, `_delete`, `_search` | Code snippets per project with language, category, full-text search |
| **Dependencies** | `dependency_add`, `_list`, `_get`, `_update`, `_delete`, `_scan` | Package dependencies with bulk scan from package.json etc. |
| **Environments** | `environment_create`, `_list`, `_get`, `_update`, `_delete`, `_export` | Key-value variables per environment, .env export |
| **Secrets** | `secret_set`, `_get`, `_list`, `_delete` | AES-256-GCM encrypted values |
| **Souls** | `soul_get`, `_update` | Project personality / guiding principles |
| **Commits** | `commit_list`, `_search`, `_sync` | Git commit history from GitHub/GitLab |
| **Recurring Tasks** | `recurring_task_create`, `_list`, `_get`, `_update`, `_delete` | Scheduled recurring todo creation |
| **Releases** | `release_create`, `_list`, `_get`, `_update`, `_delete`, `_sync_gitlab` | Per-project releases with assets, GitLab sync, draft/published/archived |
| **Attachments** | `attachment_upload`, `_list`, `_get`, `_download`, `_delete` | Files in MinIO/S3, optional text extraction (incl. PDF) for RAG |
| **Logs** | `log_list`, `_search`, `_stats` | Per-project structured log entries with TTL retention |
| **RAG** | `rag_search`, `rag_reindex`, `rag_status` | Semantic vector search across indexed content entities |
| **Web Search** | `web_search`, `web_fetch` | SearXNG-backed external search and readable page extraction |
| **Workspaces** | `workspace_create`, `_list`, `_get`, `_update`, `_archive`, `_delete`, `_clone`, `_pull`, `_tree`, `_read`, `_search`, `_status`, `_exec`, `_attachment_save` | Isolated sidecar workspaces for repository analysis and build/test commands |
| **Chat** | `chat_create`, `_list`, `_get`, `_send`, `_delete` | Project chat sessions through the configured LLM stack |
| **Dialog** | `notify_user`, `ask_user` | Push notifications + interactive yes/no/text questions to the user |
| **System** | `system_instructions_get`, `_set` | Global + per-project agent instructions |

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
# Edit .env (MongoDB credentials, auth, WORKSPACE_API_TOKEN, encryption key)

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
| MCP Discovery | http://localhost:3200/.well-known/mcp |

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
| `WORKSPACE_API_TOKEN` | Shared secret between backend and workspace sidecar; generate with `openssl rand -hex 32` | Yes |
| `SECRETS_ENCRYPTION_KEY` | AES-256 key (64 hex characters) | For Secrets |
| `VAPID_PUBLIC_KEY` | Web Push public key | For Push |
| `VAPID_PRIVATE_KEY` | Web Push private key | For Push |
| `MONGODB_STANDALONE` | `true` for standalone mode | No |
| `NODE_HEAP_SIZE` | Node.js heap in MB (default: 512) | No |
| `RAG_EMBEDDING_PROVIDER` | `ollama` or `openai-compatible` (default: `ollama`) | No |
| `RAG_EMBEDDING_URL` | Embedding server URL | For RAG |
| `RAG_EMBEDDING_MODEL` | Model name (default: `nomic-embed-text`) | For RAG |
| `RAG_FALLBACK_PROVIDER` | Fallback provider type | No |
| `RAG_FALLBACK_URL` | Fallback server URL | No |
| `RAG_FALLBACK_MODEL` | Fallback model name | No |
| `OLLAMA_URL` | Ollama URL. In Docker, use `http://host.docker.internal:11434`; for local backend runs, `http://localhost:11434` is fine | No |
| `CHAT_LLM_PROVIDER` | `lmstudio`, `openai-compatible`, `anthropic`, `openai` | For Chat |
| `CHAT_LLM_URL` | Chat LLM endpoint URL | For Chat |
| `CHAT_LLM_MODEL` | Chat model name | For Chat |
| `CHAT_LLM_API_KEY` | Required for `anthropic`/`openai`, optional for local providers | For Chat |
| `MINIO_ENDPOINT` | MinIO/S3 host (without protocol) | For Files |
| `MINIO_ACCESS_KEY` | MinIO access key | For Files |
| `MINIO_SECRET_KEY` | MinIO secret key | For Files |
| `MINIO_BUCKET` | Bucket name (default: `devgrimoire`) | No |

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
| `GET /.well-known/mcp` | Public MCP discovery metadata (no secrets, no project/user data) |
| `GET /.well-known/mcp.json` | Same discovery payload for clients that prefer a JSON suffix |
| `GET /server.json` | Registry-style MCP server manifest for private/client discovery |
| `GET /.well-known/mcp-server.json` | Same manifest under a well-known path |
| `GET /sse` | Legacy SSE (Claude Code, Claude Desktop) |
| `POST /messages` | Legacy SSE message endpoint |
| `POST\|GET\|DELETE /mcp` | Streamable HTTP (newer clients) |

Discovery and manifest endpoints intentionally expose only server metadata: supported transports, auth hints, capability counts, registry-style remote URLs, and a link to `/api/mcp/tools`. The generated `server.json` uses the local namespace `local.devgrimoire/devgrimoire`, explicitly does not opt into public Registry publishing, and contains no project/customer/user data or secrets. The tool catalog and all project/customer data remain protected by normal API/MCP authentication when auth is enabled.

To smoke-test registry-readiness and catch accidental metadata leaks, run from `backend/`:

```bash
DEVGRIMOIRE_BASE_URL=http://localhost:3200 npm run check:mcp-registry
```

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

> **Note:** When authentication is enabled, the HTTP MCP transports require a DevGrimoire API key (`Authorization: Bearer cv_...` or `?apiKey=cv_...`). When authentication is disabled, all endpoints including MCP are open and must be restricted via firewall or VPN.

For GitHub Copilot Cloud Agent, use a dedicated scoped API key and explicit `tools` allowlist. See [GitHub Copilot Cloud Agent MCP Preset](docs/copilot-cloud-agent-mcp.md).

## Authentication

DevGrimoire supports multi-user authentication with roles:

- **Roles** -- `admin` (full access + user management), `user` (read/write access)
- **Access Token** -- JWT, valid for 15 minutes, held in memory
- **Refresh Token** -- Opaque, valid for 7 days, stored in MongoDB with TTL index, rotated on use
- **API Keys** -- For programmatic access (e.g., CI/CD), restrictable by user role, explicit MCP `allowedTools`, and project/customer scopes
- **SSE** -- Auth via `?token=...` query parameter for UI event streams (EventSource does not support headers)
- **MCP Server** -- stdio is local-process only; HTTP/SSE transports require a DevGrimoire API key when authentication is enabled

On first startup, an admin account is created from `AUTH_USERNAME`/`AUTH_PASSWORD`. Additional users can be created in the dashboard under user management.

## Secrets & Encryption

Secrets are stored AES-256-GCM encrypted in MongoDB:

- Each secret has its own random IV
- Storage format: `iv:authTag:ciphertext` (all hex)
- List endpoint returns only keys + description, never values
- Decryption only via `GET /api/secrets/:id` or `secret_get` MCP tool
- Without `SECRETS_ENCRYPTION_KEY`, the secrets feature is disabled

## RAG (Semantic Search)

DevGrimoire includes a built-in RAG (Retrieval-Augmented Generation) system for semantic search across indexed content entities in a project. Unlike keyword search, RAG understands meaning -- searching for "how do I deploy" also finds entries about "Docker Compose setup" or "CI/CD pipeline".

### How it works

- **LanceDB** (embedded, no extra service) stores vector embeddings on disk
- **Ollama** or any **OpenAI-compatible API** (LM Studio, vLLM, etc.) generates embeddings
- **Indexed entities**: Knowledge, Research, Manuals, Changelogs, Todos, Sessions, Snippets, Attachments, Schemas
- **Auto-sync**: New/updated/deleted documents are automatically indexed via Change Streams

### Setup

1. Install an embedding model:
   ```bash
   # Option A: Ollama (CPU)
   ollama pull nomic-embed-text

   # Option B: LM Studio (GPU) -- load nomic-embed-text-v2-moe via UI
   ```

2. Configure in `.env`:
   ```env
   # Ollama (default)
   RAG_EMBEDDING_PROVIDER=ollama
   RAG_EMBEDDING_MODEL=nomic-embed-text

   # Or: LM Studio / OpenAI-compatible (GPU, much faster)
   RAG_EMBEDDING_PROVIDER=openai-compatible
   RAG_EMBEDDING_URL=http://<gpu-host>:1234
   RAG_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v2-moe

   # Optional: automatic fallback when primary is unavailable
   RAG_FALLBACK_PROVIDER=ollama
   # Backend in Docker: use host.docker.internal for services on the Docker host.
   # Backend running directly on the host: localhost is fine.
   RAG_FALLBACK_URL=http://host.docker.internal:11434
   RAG_FALLBACK_MODEL=nomic-embed-text-v2-moe
   ```

3. Build the initial index:
   ```
   rag_reindex  (via MCP tool)
   ```

### MCP Tools

| Tool | Description |
|------|-------------|
| `rag_search` | Semantic search with optional filters (projectId, entity type including `schema`, limit) |
| `rag_reindex` | Rebuild the full vector index (all projects or a specific one) |
| `rag_status` | Index statistics, active endpoint, fallback configuration |

> **Note:** RAG is optional. If no embedding server is available, the app starts normally with RAG features disabled.

## Project Chat

In-dashboard chat with a configurable LLM. Each chat session is scoped to a project, the system prompt is auto-built from the project context (RAG hits, attachments, history), and tool-calling lets the LLM read or even write project data through a per-tool allowlist.

### Providers

| Provider | Auth | Streaming Tool-Calls | Vision |
|----------|------|----------------------|--------|
| `lmstudio` | Bearer optional | ✓ | If model supports it |
| `openai-compatible` | Bearer optional | ✓ | If model supports it (also covers Ollama via its `/v1` shim) |
| `anthropic` | `x-api-key` required | Roadmap (T-71) | ✓ (Claude 3+) |
| `openai` | Bearer required | ✓ | ✓ (GPT-4o etc.) |

For Ollama specifically: configure as `openai-compatible`. Use `http://host.docker.internal:11434` when the backend runs in Docker and Ollama runs on the host; use `http://localhost:11434` only for non-Docker backend runs. The Ollama OpenAI compatibility shim covers tools and vision since v0.3. Native Ollama provider was retired in M-12; existing configs auto-migrate.

### Tool-Calling

Tools are split into **read** and **write** groups, opt-in per tool. By default only a small read-only allowlist (RAG search, knowledge search, todo list, milestone list) is enabled. Write tools (todo creation, milestone updates, knowledge save, etc.) must be enabled explicitly per tool and are surfaced in the UI with a warning. Every write call is recorded in the per-project log feed.

Destructive bulk operations (`project_delete`, all `_delete` tools) are hard-coded as never-callable, regardless of allowlist contents.

### Attachments

Users can attach text files (Markdown, PDF, source code, JSON, etc.) and images to chat messages. Text is extracted and injected into the system prompt with a per-file cap (20k chars) and a global budget (80k chars). Images are forwarded to the LLM in the provider-specific format -- requires a vision-capable endpoint, which the user marks per endpoint.

API keys are AES-256-GCM encrypted in the settings DB and never returned in plain text by the config endpoint.

## Distributed Sync (Replication)

DevGrimoire can replicate data between two instances. Three roles are available:

- **`master` -> `slave`** -- One-way replication for backup setups; the slave is read-only and can be promoted on failover
- **`peer` <-> `peer`** -- Symmetric bidirectional sync; both sides remain writable, conflicts resolved via **last-write-wins** on `updatedAt`
- **`standalone`** -- Default; no replication

### Per-Project Opt-in

Replication is opt-in **per project** via a checkbox in Settings -> Replication. Personal projects you don't enable stay local; only enabled projects flow to the peer/slave. This is the typical home/office setup: keep private projects at home, share work projects with the office instance.

### Offline Behaviour

Events are queued in MongoDB when the peer is unreachable and replayed on reconnect. A nightly full-sync (configurable cron) backfills anything the queue may have missed. For peer mode both instances should be NTP-synchronized -- last-write-wins becomes arbitrary if clocks drift.

### Setup

1. Set both instances to role `peer` in Settings -> Replication
2. Configure the counterparty URL + a shared API key on each side
3. Generate the same `SECRETS_ENCRYPTION_KEY` on both (so encrypted secrets stay decryptable)
4. Tick the projects you want to replicate -- they appear on the other side after the next event or full-sync

## Project Import/Export

Complete project data (todos, milestones, knowledge, changelog, sessions, schemas, dependencies, features, snippets, manuals, research, environments, secrets) can be exported as JSON and imported into a new instance. All internal references (milestone links, dependencies, changelog associations) are correctly remapped.

- **Export**: Project settings > Data export (optionally with decrypted secret values)
- **Import**: Project overview > Import JSON

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | NestJS 11, Mongoose 8, TypeScript 5, Passport JWT, LanceDB |
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
│       ├── mcp-tools.ts           # MCP tool definitions (126 tools)
│       ├── auth/                  # JWT auth, roles, API keys, user management
│       ├── projects/              # Projects (schema, service, controller, DTOs)
│       ├── todos/                 # Tasks (state machine, dependencies, comments)
│       ├── milestones/            # Milestones (changelog association)
│       ├── sessions/              # Work sessions
│       ├── knowledge/             # Knowledge base (full-text search, project + global scope)
│       ├── changelog/             # Version changelog
│       ├── manuals/               # Categorized manuals
│       ├── research/              # Research with sources
│       ├── schemas/               # DB schema documentation (versioning)
│       ├── features/              # Feature catalog
│       ├── snippets/              # Code snippets (language, category, full-text search)
│       ├── dependencies/          # Package dependencies (scan)
│       ├── environments/          # Environment variables (dev/staging/prod)
│       ├── secrets/               # Encrypted secrets (AES-256-GCM)
│       ├── releases/              # Per-project release tracking + GitLab sync
│       ├── attachments/           # MinIO/S3 file storage with text extraction
│       ├── chat/                  # Project chat: multi-provider LLM, tool-calling, attachments
│       ├── logs/                  # Per-project structured logs with TTL retention
│       ├── replication/           # Master/Slave + Peer-mode bidirectional sync
│       ├── commits/               # Git commit history (GitHub/GitLab sync)
│       ├── recurring-tasks/       # Scheduled recurring todo creation
│       ├── souls/                 # Per-project guiding principles
│       ├── questions/             # ask_user interactive dialog
│       ├── minio/                 # MinIO/S3 client wrapper
│       ├── activities/            # Activity feed (auto-logged)
│       ├── notifications/         # In-app notifications
│       ├── events/                # SSE events (Change Streams + EventEmitter)
│       ├── push/                  # Web Push (VAPID)
│       ├── rag/                   # RAG semantic search (LanceDB + embeddings)
│       ├── search/                # Global search
│       ├── settings/              # System settings
│       ├── api-keys/              # API key management
│       ├── counters/              # Auto-increment numbers (T-1, M-1)
│       ├── project-transfer/      # JSON import/export
│       └── common/                # Shared (encryption, pipes, interceptors)
├── frontend/
│   └── src/
│       ├── pages/                 # Dashboard, project detail, todo detail, login, settings, docs, ...
│       ├── components/            # TodoBoard, MilestoneList, SchemaList, ChatDock, LogList, ReleaseList, ReplicationSettings, ...
│       ├── components/ui/         # Button, Badge, ConfirmButton, EmptyState, ...
│       ├── api/                   # REST client + browserLlmClient (browser-mode chat streaming)
│       └── hooks/                 # useAuth, useProjectEvents
├── docker-compose.yml             # Standard (replica set)
├── docker-compose.standalone.yml  # ARM/Standalone (without replica set)
├── docs/                          # Setup, security, MCP, workspace, web-search, operations docs
├── .env.example
├── CLAUDE.md                      # Instructions for Claude Code
└── README.md
```

## License

[AGPL-3.0](LICENSE) -- You are free to use, self-host, and modify DevGrimoire. If you operate a modified version as a service, you must publish the source code.
