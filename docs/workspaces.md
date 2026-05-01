# Workspaces

Workspaces are isolated sidecar-container scratch spaces bound to DevGrimoire projects. They are used by `workspace_*` MCP tools for repository clone, read, search, status, and controlled command execution.

## Required Environment

`docker-compose.yml` requires:

```env
WORKSPACE_API_TOKEN=<openssl rand -hex 32>
```

The backend talks to the sidecar over the internal `workspace-api-net` network through:

```env
WORKSPACE_API_URL=http://workspace:9000
```

## Network Model

The sidecar is attached to two networks:

- `workspace-api-net`: internal-only network used by the backend to call the sidecar API.
- `workspace-net`: outbound network for git, package managers, and build/test commands.

The sidecar has no direct route to MongoDB or the backend's default Docker network. It can still reach external networks and, depending on host firewall rules, services on the operator's LAN.

## Safety Boundaries

`workspace_exec` runs as a non-root user with a scrubbed environment, timeout limits, output caps, and a blacklist for dangerous command patterns. It is still code execution and should be enabled only for trusted operators or trusted agent workflows.

Use `workspace_read` and `workspace_search` for inspection before using `workspace_exec`.

## Useful Tools

| Tool | Purpose |
| --- | --- |
| `workspace_create` | Create workspace metadata for a project |
| `workspace_clone` | Clone a repository into the workspace volume |
| `workspace_pull` | Fast-forward pull an existing clone |
| `workspace_tree` | List files with bounded depth |
| `workspace_read` | Read one UTF-8 file |
| `workspace_search` | Run ripgrep over the workspace |
| `workspace_status` | Return git status |
| `workspace_exec` | Run bounded build/lint/test commands |
| `workspace_attachment_save` | Persist a workspace artifact as a DevGrimoire attachment |
