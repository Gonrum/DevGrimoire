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

/**
 * Parses `grep -rnIZ` output (`path NUL line:text NL`). The NUL after the path
 * keeps colons and spaces in file names unambiguous. The column is the first
 * occurrence of a fixed-string query (honouring `caseSensitive`), else 1.
 * Lines that do not fit the shape (grep notices) are skipped; a path that
 * contains a newline cannot be told apart and is skipped as well.
 */
export function parseGrepOutput(
  stdout: string,
  opts: { query: string; regex: boolean; caseSensitive: boolean },
  limit: number,
): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
  for (const raw of stdout.split('\n')) {
    const nul = raw.indexOf('\0');
    if (nul <= 0) continue;
    const m = /^(\d+):([\s\S]*)$/.exec(raw.slice(nul + 1));
    if (!m) continue;
    const text = (m[2] ?? '').replace(/\r$/, '');
    let column = 1;
    if (!opts.regex) {
      const at = (opts.caseSensitive ? text : text.toLowerCase()).indexOf(needle);
      if (at >= 0) column = at + 1;
    }
    matches.push({
      path: raw.slice(0, nul).replace(/^\.\//, ''),
      line: Number(m[1]),
      column,
      text: text.slice(0, MAX_TEXT_CHARS),
    });
    if (matches.length >= limit) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

/**
 * Maps a git status taken at the repository root onto a workspace that is a
 * subdirectory of it. `prefix` is `git rev-parse --show-prefix` (`sub/` or
 * empty). Paths outside the prefix drop out; paths inside lose it. A rename
 * is reported by its new path only (see `parseGitStatus`), so the new path
 * alone decides. An untracked directory that is the workspace itself or one
 * of its parents cannot be placed inside it and drops out too.
 */
export function relativizeStatus(
  parsed: { branch: string | null; changed: { path: string; code: string }[] },
  prefix: string,
): { branch: string | null; changed: { path: string; code: string }[] } {
  if (!prefix) return parsed;
  const changed: { path: string; code: string }[] = [];
  for (const entry of parsed.changed) {
    if (!entry.path.startsWith(prefix) || entry.path.length === prefix.length) continue;
    changed.push({ ...entry, path: entry.path.slice(prefix.length) });
  }
  return { branch: parsed.branch, changed };
}
