import { SetMetadata } from '@nestjs/common';

export const MCP_TOOL_EQUIVALENT_KEY = 'mcpToolEquivalent';

/**
 * Marks a REST route as the counterpart of an MCP tool.
 *
 * An API key with `allowedTools` is an MCP-only key. Without this, the
 * "only these tools" restriction applied to `/mcp` and `/sse` alone, while
 * the same key reached everything its owner may access over REST, including
 * `GET /api/secrets/:id` with the decrypted value. `JwtAuthGuard` therefore
 * rejects such keys on REST UNLESS the route is mapped here to a tool that
 * is on the key's allowlist.
 *
 * Only use it for routes that cannot do more than the tool itself.
 */
export const McpToolEquivalent = (toolName: string) => SetMetadata(MCP_TOOL_EQUIVALENT_KEY, toolName);
