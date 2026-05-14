# MCP Apps Security and Audit Model

MCP Apps (`io.modelcontextprotocol/ui`) can let DevGrimoire expose interactive `ui://` resources such as todo cards or workflow summaries to compatible MCP hosts. Treat these resources as untrusted, sandboxed presentation surfaces: useful for review and interaction, never a place to embed secrets or bypass DevGrimoire's existing auth, scope, and audit rules.

Status: design baseline for future implementation. Do not expose interactive UI resources until the checklist below is implemented.

## Threat model

### Assets to protect

- DevGrimoire API keys, JWTs, encrypted secret values, workspace tokens, chat endpoint keys, and environment exports.
- Project/customer-scoped data outside the caller's allowed scope.
- User identity and role information beyond what the requested UI needs to render.
- Tool results, logs, attachments, and workspace output that may contain sensitive content.
- DevGrimoire discovery/server manifests, which must remain non-sensitive and not reveal per-key state.

### Attackers and failure modes

- A malicious or compromised MCP host rendering a DevGrimoire UI resource.
- A malicious project artifact that causes injected HTML/JS inside a UI resource.
- A UI iframe attempting to call tools outside its intended app capability or caller scope.
- A tool result that links to a UI resource without capability negotiation or fallback.
- External URLs used to exfiltrate data, load unreviewed scripts, or fingerprint users.
- Error messages that leak IDs, scopes, stack traces, secrets, or internal infrastructure.

## Mandatory controls

### Capability negotiation and fallback

- Only advertise or attach MCP Apps metadata after the client has negotiated `io.modelcontextprotocol/ui` support.
- Tool responses must remain useful without UI support. Return normal text/JSON first; add UI linkage as optional metadata.
- If the client lacks UI support, return the existing non-UI tool response and log a non-error fallback event.
- Do not require UI resources for destructive actions or approvals; keep those flows explicit in normal tools.

### `ui://` resource rules

- UI resources must use the `ui://` scheme and `text/html;profile=mcp-app` MIME type.
- HTML must be generated from templates with escaped data; never concatenate raw Markdown/HTML from project content into executable markup.
- Do not embed API keys, JWTs, secret values, bearer tokens, signed URLs, or unrestricted REST endpoints in HTML.
- Prefer read-only UI resources at first. Any UI-triggered action must call a normal MCP tool and pass through the existing tool allowlist, permission, and scope checks.
- Keep resource payloads small and entity-specific. A todo UI resource should not preload unrelated project data.

### Sandbox, CSP, and external origins

Default posture: no network access from app iframes.

- Declare no external domains unless a concrete feature requires them.
- `connectDomains` should default to empty; UI-to-server actions should go through host-mediated MCP tool calls, not direct REST calls.
- `resourceDomains` should default to empty. Inline minimal CSS is preferred for first prototypes.
- `frameDomains` should default to empty. Nested iframes are forbidden unless separately reviewed.
- `baseUriDomains` should default to same-origin only.
- Do not use wildcard domains for production UI resources.
- If a dedicated sandbox domain is requested, validate it against a configured allowlist; never derive it from user input.
- Apps must use feature detection and graceful degradation for host-denied permissions.

Recommended minimum CSP metadata for initial DevGrimoire resources:

```json
{
  "ui": {
    "csp": {
      "connectDomains": [],
      "resourceDomains": [],
      "frameDomains": [],
      "baseUriDomains": []
    },
    "prefersBorder": true
  }
}
```

### Scope enforcement

Server-side scope checks remain authoritative.

- Every `resources/read` equivalent and every tool linked to UI must resolve the caller from the same auth context as normal MCP calls.
- Enforce project/customer scope on the server before rendering HTML.
- UI resource URIs must not be trusted as authorization. Treat IDs in `ui://...` as selectors only, then re-check scope.
- Per-key `allowedTools` still applies. A UI marked app-callable must not bypass `allowedTools`.
- If a tool is app-only, it is still server-side audited and scoped; app-only means hidden from the model, not exempt from permission checks.

### Discovery and manifests

- Public discovery and server manifests may list aggregate MCP Apps capability only.
- Do not include project IDs, customer IDs, user IDs, API-key scopes, per-key tool allowlists, resource URIs for private entities, or secrets.
- If tool metadata includes UI linkage, expose it only through authenticated tool catalog/session surfaces that already respect the caller's key and scopes.

## Audit model

Log UI-resource delivery and UI-triggered actions to structured Logs/Audit without storing secrets or full HTML payloads.

### UI resource delivery event

Emit when a UI resource is rendered/read.

Suggested fields:

- `service`: `mcp-apps`
- `area`: `ui-resource`
- `event`: `ui_resource_read`
- `projectId` / `customerId` when applicable
- `resourceUri`
- `resourceType` such as `todo-card` or `workflow-summary`
- `entityType` and `entityId`
- `actorType`: `api-key`, `jwt`, or `system`
- `apiKeyPrefix` only, never the raw key
- `hostName` / `clientName` when available
- `capabilityNegotiated`: boolean
- `fallbackUsed`: boolean
- `cspHash` or normalized CSP summary, not the full HTML
- `result`: `allowed`, `denied_scope`, `denied_capability`, `error_redacted`

### UI-to-tool action event

Emit before/after a UI-initiated tool call.

Suggested fields:

- `event`: `ui_tool_action`
- `sourceResourceUri`
- `toolName`
- `visibility`: `app` or `model+app`
- `entityType` / `entityId`
- `actorType` and `apiKeyPrefix`
- `allowedToolsMatched`: boolean
- `scopeMatched`: boolean
- `status`: `allowed`, `denied_tool`, `denied_scope`, `failed_validation`, `completed`
- `errorCode` with redacted message for failures

Do not log request bodies verbatim if they may contain secrets, attachment text, chat content, or workspace output. Store compact metadata and entity references instead.

## Required tests and check script

Before enabling MCP Apps in DevGrimoire, add automated coverage for these cases:

1. **Unauthorized scope**: caller with project/customer allowlist cannot read a UI resource for another scope; response is a generic 403 and audit result is `denied_scope`.
2. **Missing capability negotiation**: client without `io.modelcontextprotocol/ui` receives normal text/JSON fallback and no UI resource metadata.
3. **Fallback with UI unsupported**: `todo_get` or the chosen prototype remains functionally equivalent for existing MCP clients.
4. **Redacted errors**: invalid entity IDs, missing resources, and thrown renderer errors do not expose secrets, stack traces, or filesystem paths.
5. **CSP defaults**: generated UI metadata defaults to no external `connectDomains`, `resourceDomains`, or `frameDomains`.
6. **No secrets in HTML**: fixture-rendered HTML does not contain API key prefixes beyond approved audit metadata, JWT-looking strings, encrypted secret values, or configured secret names.
7. **Tool allowlist**: UI-initiated tool action is denied when the API key lacks the target tool in `allowedTools`.
8. **Discovery safety**: public discovery/server manifests do not include private resource URIs, project/customer IDs, per-key scopes, or per-key allowlists.

Recommended script shape:

```bash
cd backend
npm run check:mcp-apps-security
```

The check should start from fixture data and exercise the same rendering/helper functions used by the MCP transport. It should not require external network access.

## Initial rollout recommendation

1. Implement a read-only `todo_get` UI resource prototype.
2. Keep direct network access disabled in CSP.
3. Link UI metadata only after capability negotiation.
4. Add the security check script and manifest regression checks before merging more UI resources.
5. Expand to additional UI resource types only after the audit and fallback behavior is proven.

## Sources

- MCP Apps extension specification, stable 2026-01-26: `io.modelcontextprotocol/ui`, `ui://` resources, `text/html;profile=mcp-app`, tool `_meta.ui.resourceUri`, capability negotiation, iframe sandboxing, CSP metadata, and auditability expectations.
- DevGrimoire existing security model: API keys, `allowedTools`, project/customer scopes, structured logs/audit, and non-sensitive MCP discovery manifests.
