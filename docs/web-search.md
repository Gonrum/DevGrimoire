# Web Search

DevGrimoire can expose `web_search` and `web_fetch` MCP tools through a self-hosted SearXNG instance.

## Compose Setup

The default Compose stack includes SearXNG internally. It is not exposed on a host port.

The backend default is:

```env
SEARXNG_URL=http://searxng:8080
```

Set a strong secret in `.env`:

```env
SEARXNG_SECRET=<openssl rand -hex 32>
```

Only override `SEARXNG_URL` when using an external SearXNG instance.

## Tools

| Tool | Purpose |
| --- | --- |
| `web_search` | Search public web results through SearXNG |
| `web_fetch` | Fetch and extract readable text from a public URL |

`web_fetch` is SSRF-protected and blocks private or loopback IPs. Binary content is rejected; use attachments for PDFs, images, archives, or generated artifacts.
