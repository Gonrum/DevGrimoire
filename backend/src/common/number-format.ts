export function formatEntityNumber(
  pattern: string,
  seq: number,
  projectName: string,
  entityType: 'T' | 'M',
): string {
  return pattern
    .replace(/\{n\}/g, String(seq))
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{prefix\}/g, projectName)
    .replace(/\{type\}/g, entityType);
}
