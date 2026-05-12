# GitHub Copilot Cloud Agent MCP Preset

GitHub Copilot Cloud Agent can connect repository/custom-agent MCP servers with an `mcpServers` config. For DevGrimoire, treat Copilot Cloud Agent as an autonomous tool caller: once a tool is allowlisted for the agent, GitHub may let the agent call it without another DevGrimoire-side confirmation prompt.

Default stance: use a dedicated DevGrimoire API key with an explicit read-only tool allowlist. Do not use wildcard `*` or an unrestricted API key for production projects.

## Secret and variable naming

GitHub only exposes MCP variables/secrets that use the `COPILOT_MCP_` prefix. Store the DevGrimoire API key as a GitHub secret, for example:

- `COPILOT_MCP_DEVGRIMOIRE_URL=https://devgrimoire.example.com`
- `COPILOT_MCP_DEVGRIMOIRE_API_KEY=<DevGrimoire API key>`

Never commit the raw API key into `.github/copilot*`, repository settings exports, docs, or examples.

## Recommended HTTP config

Use Streamable HTTP when possible:

```json
{
  "mcpServers": {
    "devgrimoire": {
      "type": "http",
      "url": "${COPILOT_MCP_DEVGRIMOIRE_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${COPILOT_MCP_DEVGRIMOIRE_API_KEY}"
      },
      "tools": [
        "project_list",
        "project_get",
        "todo_list",
        "todo_get",
        "milestone_list",
        "knowledge_search",
        "rag_search"
      ]
    }
  }
}
```

## Legacy SSE config

Use SSE only for clients/configurations that cannot send MCP HTTP headers:

```json
{
  "mcpServers": {
    "devgrimoire": {
      "type": "sse",
      "url": "${COPILOT_MCP_DEVGRIMOIRE_URL}/sse?apiKey=${COPILOT_MCP_DEVGRIMOIRE_API_KEY}",
      "tools": [
        "project_get",
        "todo_list",
        "todo_get",
        "knowledge_search",
        "rag_search"
      ]
    }
  }
}
```

Prefer HTTP headers over query-string API keys where the GitHub configuration surface supports them.

## Tool presets

### Read-only default

Use this for most repositories and first-time setup:

```json
[
  "project_list",
  "project_get",
  "todo_list",
  "todo_get",
  "milestone_list",
  "milestone_get",
  "knowledge_search",
  "knowledge_list",
  "manual_list",
  "changelog_list",
  "rag_search",
  "feature_list",
  "dependency_list",
  "release_list",
  "schema_list"
]
```

### Project-management write

Only enable after reviewing the repository and agent prompt. These can create project artifacts but should still avoid external execution:

```json
[
  "todo_create",
  "todo_update",
  "todo_comment",
  "knowledge_create",
  "manual_create",
  "changelog_create",
  "doc_update_proposal_create",
  "doc_update_proposal_convert_to_todo"
]
```

### High-risk / workspace execution

Keep these disabled by default for Copilot Cloud Agent. Enable only on a dedicated sandbox project/API key with an explicit approval process:

- `workspace_exec`
- `workspace_git_*`
- release/deploy/sync tools
- secret/environment export or mutation tools
- destructive deletes/archive/bulk operations
- external HTTP/webhook/email tools

## DevGrimoire API-key setup checklist

1. Create a dedicated API key for GitHub Copilot Cloud Agent.
2. Set project/customer scope as narrowly as possible.
3. Set `allowedTools` explicitly to the selected preset tools.
4. Avoid wildcard `*` and avoid unrestricted keys.
5. Rotate the key if repository access changes.
6. Review DevGrimoire logs after enabling write tools.

## Compatibility notes

- Copilot Cloud Agent currently focuses on MCP tools; do not rely on MCP resources/prompts for critical context.
- Remote MCP OAuth flows may not be available in the cloud-agent path, so DevGrimoire API keys are the practical auth mechanism.
- DevGrimoire discovery endpoints (`/.well-known/mcp`, `/server.json`) intentionally do not expose per-key tool allowlists or secrets. The Copilot config should carry only the client-side `tools` allowlist and secret references.
