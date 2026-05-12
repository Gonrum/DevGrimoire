export function generateNodeId(type: string, existingIds: string[]): string {
  const prefix = (type.split('.').pop() ?? 'node').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  let counter = 1;
  let candidate = prefix;
  const ids = new Set(existingIds);
  while (ids.has(candidate)) {
    counter++;
    candidate = `${prefix}_${counter}`;
  }
  return candidate;
}
