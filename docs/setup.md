# Setup

This document complements the root `README.md` with the details needed to run a fresh DevGrimoire instance.

## Required Steps

1. Copy the example environment:

   ```bash
   cp .env.example .env
   ```

2. Edit at least these values:

   ```env
   MONGO_PASSWORD=<strong-password>
   AUTH_USERNAME=admin
   AUTH_PASSWORD=<strong-password>
   JWT_SECRET=<random-string>
   WORKSPACE_API_TOKEN=<openssl rand -hex 32>
   SEARXNG_SECRET=<openssl rand -hex 32>
   ```

3. Optional but recommended before using secrets, chat API keys, or replication credentials:

   ```env
   SECRETS_ENCRYPTION_KEY=<openssl rand -hex 32>
   ```

4. Start the stack:

   ```bash
   docker compose up -d
   ```

## Service URLs

| Service | URL |
| --- | --- |
| Frontend | `http://localhost` |
| REST API | `http://localhost:3200/api` |
| Legacy MCP SSE | `http://localhost:3200/sse` |
| Streamable MCP HTTP | `http://localhost:3200/mcp` |

## Docker Host URLs

When the backend runs in Docker and needs to reach a service on the Docker host, prefer `host.docker.internal`.

| Service | Backend in Docker | Backend running locally |
| --- | --- | --- |
| Ollama | `http://host.docker.internal:11434` | `http://localhost:11434` |
| LM Studio | `http://host.docker.internal:1234` | `http://localhost:1234` |
| SearXNG in Compose | `http://searxng:8080` | not applicable |

## Profiles

Standard mode uses MongoDB as a single-node replica set so Change Streams work.

For lower-resource ARM/standalone deployments:

```bash
docker compose -f docker-compose.yml -f docker-compose.standalone.yml up -d
```

Standalone mode does not use MongoDB Change Streams. Realtime updates still work through the in-process EventEmitter while the HTTP backend is running.
