# Security

DevGrimoire is intended for trusted networks or deployment behind a VPN/reverse proxy. Do not expose a default instance directly to the public internet.

## Authentication Modes

Authentication is enabled when `AUTH_USERNAME` and `AUTH_PASSWORD` are set. On first startup DevGrimoire creates the initial admin user from those values.

If those values are empty, authentication is disabled and all REST and MCP endpoints are open.

## REST API Auth

With auth enabled, REST endpoints require either:

- a JWT access token from the login flow
- a DevGrimoire API key in `Authorization: Bearer cv_...`
- a DevGrimoire API key as `?apiKey=cv_...`

Public auth endpoints such as `/api/auth/login` and `/api/auth/status` remain reachable without a token.

## MCP Auth

The HTTP MCP transports are protected by API keys when auth is enabled:

```json
{
  "mcpServers": {
    "devgrimoire": {
      "type": "http",
      "url": "http://server:3200/mcp",
      "headers": {
        "Authorization": "Bearer cv_..."
      }
    }
  }
}
```

For legacy SSE clients that cannot send headers:

```json
{
  "mcpServers": {
    "devgrimoire": {
      "type": "sse",
      "url": "http://server:3200/sse?apiKey=cv_..."
    }
  }
}
```

The local stdio MCP server remains local-process only and does not use HTTP auth.

## Secrets

`SECRETS_ENCRYPTION_KEY` must be a 64-character hex string generated with:

```bash
openssl rand -hex 32
```

The same encryption service protects project secrets, chat endpoint API keys, and replication credentials. Without this key, features that need encrypted storage are disabled or reject cloud-provider key storage.

## Deployment Notes

- Keep MongoDB bound to localhost unless you intentionally operate it behind a private network.
- Put HTTP endpoints behind VPN, firewall, or a trusted reverse proxy.
- Rotate `WORKSPACE_API_TOKEN`, `JWT_SECRET`, and `SECRETS_ENCRYPTION_KEY` deliberately; changing encryption keys can make existing encrypted values unreadable.
