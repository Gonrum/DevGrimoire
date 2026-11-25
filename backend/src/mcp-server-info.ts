import { oauthResourceFromBaseUrl } from './oauth/oauth-tokens';

/** Icon entry of the MCP `Implementation` (serverInfo) — spec 2025-11-25. */
interface McpIcon {
  src: string;
  mimeType: string;
  sizes: string[];
}

/** What DevGrimoire reports as `serverInfo` in the MCP initialize result. */
export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
  websiteUrl?: string;
  icons?: McpIcon[];
}

type Env = Record<string, string | undefined>;

/**
 * Server name and version, plus title, website and icons when a public base
 * URL is known. Clients (Claude Desktop/claude.ai connectors) need absolute
 * icon URLs they can fetch themselves; without `PUBLIC_BASE_URL` there is no
 * reliable public origin, so the icons are left out rather than guessed from
 * request headers. Independent of whether OAuth is enabled.
 */
export function mcpServerInfo(env: Env = process.env): McpServerInfo {
  const info: McpServerInfo = { name: 'DevGrimoire', version: '1.0.0' };
  const resource = env.PUBLIC_BASE_URL ? oauthResourceFromBaseUrl(env.PUBLIC_BASE_URL.trim()) : null;
  if (!resource) return info;
  const origin = new URL(resource).origin;
  return {
    ...info,
    title: 'DevGrimoire',
    websiteUrl: `${origin}/`,
    icons: [
      { src: `${origin}/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
      { src: `${origin}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
    ],
  };
}
