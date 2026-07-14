const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
  Ä: 'ae', Ö: 'oe', Ü: 'ue',
};

export function slugifyFilename(text: string, fallback = 'stack'): string {
  const slug = (text || '')
    .replace(/[äöüßÄÖÜ]/g, (c) => UMLAUT_MAP[c] ?? c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

interface StackLike {
  name: string;
  description?: string;
  entries: { title: string; content: string; order: number }[];
}

export function stackToMarkdown(stack: StackLike): string {
  const lines: string[] = [`# ${stack.name}`];
  if (stack.description && stack.description.trim()) {
    lines.push('', stack.description.trim());
  }
  const sorted = [...stack.entries].sort((a, b) => a.order - b.order);
  for (const entry of sorted) {
    lines.push('', `## ${entry.title}`, entry.content);
  }
  return lines.join('\n') + '\n';
}

export function entryToMarkdown(entry: { title: string; content: string }): string {
  return `# ${entry.title}\n${entry.content}\n`;
}
