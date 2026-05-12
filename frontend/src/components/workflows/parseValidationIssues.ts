export interface RemoteIssue {
  nodeId?: string;
  nodeType?: string;
  message?: string;
  rawMessage?: string;
}

const PATTERN = /node "(?<id>[^"]+)"(?:\s*\((?<type>[^)]+)\))?\s*(?<rest>.+)/;

export function parseValidationIssues(msg: string): RemoteIssue[] {
  return msg
    .replace(/^.*?:\s*/, '')
    .split(/;\s*/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(PATTERN);
      if (!m?.groups) return { rawMessage: line };
      return {
        nodeId: m.groups.id,
        nodeType: m.groups.type,
        message: m.groups.rest,
      };
    });
}
