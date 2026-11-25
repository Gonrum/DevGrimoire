/**
 * Pure logic for code attachments in the IDE agent chat. Import-free so the
 * check script can compile it on its own. The shape mirrors the backend
 * `CodeRef` (backend/src/chat/code-refs.ts).
 */
export type ChatCodeRef =
  | { kind: 'selection'; path: string; startLine: number; endLine: number; text: string; unsaved?: boolean }
  | { kind: 'file'; path: string };

export const MAX_CODE_REFS = 10;
export const MAX_CODE_REF_TEXT = 20_000;

export type AddCodeRefResult = 'added' | 'duplicate' | 'too-large' | 'full' | 'invalid';

interface SelectionLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * 1-based line range of a Monaco selection. A selection that ends in column 1
 * of a later line selected no text on that line, so it is not counted.
 */
export function selectionLines(sel: SelectionLike): { startLine: number; endLine: number } {
  const endLine =
    sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
  return { startLine: sel.startLineNumber, endLine };
}

const MAX_PATH_LENGTH = 1024;

// Mirrors the backend rule: controls, backtick, line/paragraph separators and bidi controls.
function hasControlOrTick(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (
      c < 0x20
      || (c >= 0x7f && c <= 0x9f)
      || c === 0x60
      || c === 0x2028 || c === 0x2029
      || (c >= 0x202a && c <= 0x202e)
      || (c >= 0x2066 && c <= 0x2069)
    ) return true;
  }
  return false;
}

/** Workspace-relative path as the backend accepts it. */
export function isValidCodeRefPath(value: string): boolean {
  if (value.length < 1 || value.length > MAX_PATH_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\') || hasControlOrTick(value)) return false;
  return value.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function sameRef(a: ChatCodeRef, b: ChatCodeRef): boolean {
  if (a.kind !== b.kind || a.path !== b.path) return false;
  if (a.kind === 'selection' && b.kind === 'selection') {
    return a.startLine === b.startLine && a.endLine === b.endLine;
  }
  return true;
}

export function addCodeRef(
  list: readonly ChatCodeRef[],
  ref: ChatCodeRef,
): { list: ChatCodeRef[]; result: AddCodeRefResult } {
  const current = [...list];
  if (!isValidCodeRefPath(ref.path)) return { list: current, result: 'invalid' };
  if (current.some((r) => sameRef(r, ref))) return { list: current, result: 'duplicate' };
  if (ref.kind === 'selection' && ref.text.length > MAX_CODE_REF_TEXT) return { list: current, result: 'too-large' };
  if (current.length >= MAX_CODE_REFS) return { list: current, result: 'full' };
  return { list: [...current, ref], result: 'added' };
}

export function codeRefLabel(ref: ChatCodeRef): string {
  if (ref.kind === 'file') return ref.path;
  return ref.startLine === ref.endLine
    ? `${ref.path}:${ref.startLine}`
    : `${ref.path}:${ref.startLine}–${ref.endLine}`;
}
