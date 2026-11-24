/**
 * Characters of a tool result's JSON the chat loop hands to the LLM (and
 * streams/stores); anything longer is cut at the end with `…[truncated]`.
 * Tools whose tail matters (ws_exec) shape their result to stay below it.
 */
export const MAX_TOOL_RESULT_CHARS = 8000;
