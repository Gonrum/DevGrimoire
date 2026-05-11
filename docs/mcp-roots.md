# MCP Roots for Workspace Tools

DevGrimoire treats MCP client roots as an extra safety boundary for workspace operations.

## Decision

- Existing DevGrimoire permissions remain authoritative: user scope, API-key scope, project ownership and workspace lookup are checked first.
- Client roots can only narrow access. They never grant access to projects, repos or files the caller could not already reach.
- Clients without `roots/list` support keep the previous behavior for compatibility.

## Enforcement

When a client provides roots, sidecar-backed workspace operations validate the target before touching the sidecar:

- `workspace_clone`
- `workspace_pull`
- `workspace_tree`
- `workspace_read`
- `workspace_search`
- `workspace_status`
- `workspace_exec`
- `workspace_attachment_save`

Supported root forms:

- `file://...` roots are compared to the sidecar workspace path, including the operation's relative file/subtree path where available.
- Repository URL roots are compared to the workspace `repoUrl`.

A request outside the declared roots fails before any sidecar call with a generic error that does not echo the blocked path. Existing `workspace_exec` audit logging still records successful/attempted exec outcomes after the guard; blocked requests currently fail at MCP level without leaking path details.

## Compatibility notes

MCP roots support is still uneven across clients. DevGrimoire therefore requests roots opportunistically and treats missing/unsupported roots as "no extra boundary" rather than a hard failure.

Future work can add roots change-notification caching and richer audit entries for blocked root violations once client support is more consistent.
