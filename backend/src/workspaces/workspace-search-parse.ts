import { isRecord, isUnknownArray } from '../common/narrow';

export interface SearchMatch { path: string; line: number; column: number; text: string }

const MAX_TEXT_CHARS = 300;

function textOf(value: unknown): string | null {
  // ripgrep emits `{ text }` for UTF-8 and `{ bytes }` (base64) otherwise.
  if (!isRecord(value)) return null;
  return typeof value.text === 'string' ? value.text : null;
}

/**
 * Parses ripgrep `--json` NDJSON into flat matches. Only `match` events count;
 * unparsable lines are skipped. `truncated` is set as soon as `limit` matches
 * were collected — the list is cut there.
 */
export function parseRipgrepJson(
  ndjson: string,
  limit: number,
): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  for (const raw of ndjson.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== 'match' || !isRecord(event.data)) continue;
    const data = event.data;
    const filePath = textOf(data.path);
    const lineText = textOf(data.lines);
    if (filePath === null || lineText === null || typeof data.line_number !== 'number') continue;
    const first = isUnknownArray(data.submatches) ? data.submatches[0] : undefined;
    const start = isRecord(first) && typeof first.start === 'number' ? first.start : 0;
    matches.push({
      path: filePath.replace(/^\.\//, ''),
      line: data.line_number,
      column: start + 1,
      text: lineText.replace(/\r?\n$/, '').slice(0, MAX_TEXT_CHARS),
    });
    if (matches.length >= limit) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

/**
 * Parses `git status --porcelain=v1 --branch`. Branch comes from the `## `
 * header (`main...origin/main`, `No commits yet on main`, `HEAD (no branch)`).
 */
export function parseGitStatus(output: string): { branch: string | null; changed: { path: string; code: string }[] } {
  let branch: string | null = null;
  const changed: { path: string; code: string }[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const noCommits = /^No commits yet on (.+)$/.exec(head);
      const initial = /^Initial commit on (.+)$/.exec(head);
      branch = (noCommits?.[1] ?? initial?.[1] ?? head.split('...')[0] ?? '').trim() || null;
      continue;
    }
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let filePath = line.slice(3);
    // Renames/copies read `old -> new`; the new path is what exists now.
    const arrow = filePath.lastIndexOf(' -> ');
    if (arrow >= 0 && (code[0] === 'R' || code[0] === 'C')) filePath = filePath.slice(arrow + 4);
    if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length >= 2) {
      try {
        const unquoted: unknown = JSON.parse(filePath);
        if (typeof unquoted === 'string') filePath = unquoted;
      } catch { /* keep the quoted form */ }
    }
    changed.push({ path: filePath, code });
  }
  return { branch, changed };
}
