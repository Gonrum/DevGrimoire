/**
 * Quotes one value as a single POSIX shell word: wrapped in single quotes,
 * every embedded `'` written as `'\''`. Nothing inside single quotes is
 * interpreted (no `$`, backtick, newline or leading-dash tricks), so the
 * result is safe as one argument. NUL cannot be passed through a shell at
 * all and is rejected.
 */
export function shq(value: string): string {
  if (value.includes('\0')) throw new Error('shell argument contains NUL');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
