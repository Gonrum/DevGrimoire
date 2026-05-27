/**
 * MCP Apps Extension (SEP-1865, io.modelcontextprotocol/ui) — UI-Resource-
 * Definitions for DevGrimoire. See docs/mcp-apps.md for the full mapping,
 * security model and fallback semantics.
 *
 * Resources here are served via the standard `resources/list` and
 * `resources/read` MCP RPC handlers. Clients without Apps-Extension
 * support simply ignore the `_meta.ui` annotation on linked tools and the
 * `ui://` URI scheme — fallback to the classic JSON tool result is
 * automatic and requires no additional code on either side.
 */
import { TODO_VIEW_HTML } from './todo-view.html';

export const UI_MIME_TYPE = 'text/html;profile=mcp-app';
export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';

export const TODO_UI_RESOURCE_URI = 'ui://devgrimoire/todo';

export interface UiResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  /**
   * Pre-rendered HTML body. Kept inline (not loaded from disk) so the
   * stdio MCP binary stays single-file and `npm publish` doesn't need
   * extra asset copying.
   */
  html: string;
  /**
   * `_meta.ui` block returned with the resource content. Defaults are
   * intentionally restrictive — no external CSP origins, no permissions —
   * so hosts apply the spec's default CSP (`default-src 'none'; ...`).
   */
  meta?: {
    csp?: {
      connectDomains?: string[];
      resourceDomains?: string[];
      frameDomains?: string[];
      baseUriDomains?: string[];
    };
    permissions?: {
      camera?: Record<string, never>;
      microphone?: Record<string, never>;
      geolocation?: Record<string, never>;
      clipboardWrite?: Record<string, never>;
    };
    domain?: string;
    prefersBorder?: boolean;
  };
}

export const UI_RESOURCES: UiResourceDefinition[] = [
  {
    uri: TODO_UI_RESOURCE_URI,
    name: 'Todo Detail View',
    description: 'Read-only interactive Todo card with status quick-actions',
    mimeType: UI_MIME_TYPE,
    html: TODO_VIEW_HTML,
    meta: {
      prefersBorder: true,
    },
  },
];

export function findUiResource(uri: string): UiResourceDefinition | undefined {
  return UI_RESOURCES.find((r) => r.uri === uri);
}
