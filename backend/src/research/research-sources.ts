export interface SourceEntry {
  n: number;
  url?: string;
  file?: string;
  title: string;
  notes: string;
  relevant: boolean;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return url.trim();
  }
}

/** `[n]`, `[n, m]` und Ketten `[n][m]`; nur ganze Zahlen ≥ 1. */
export function citedSourcesOf(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of m[1].split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n >= 1) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export class SourceRegistry {
  private readonly entries = new Map<number, SourceEntry>();
  private readonly read = new Set<string>();
  private nextN = 1;

  constructor(initial: SourceEntry[] = []) {
    for (const s of initial) {
      this.entries.set(s.n, { ...s });
      if (s.url) this.read.add(normalizeUrl(s.url));
      this.nextN = Math.max(this.nextN, s.n + 1);
    }
  }

  isRead(url: string): boolean { return this.read.has(normalizeUrl(url)); }

  /** Synchron, damit parallele Teilaufträge dieselbe Seite nicht doppelt lesen. */
  claim(url: string): boolean {
    const key = normalizeUrl(url);
    if (this.read.has(key)) return false;
    this.read.add(key);
    return true;
  }

  release(url: string): void { this.read.delete(normalizeUrl(url)); }

  addPage(url: string, title: string): SourceEntry {
    const entry = { n: this.nextN++, url, title, notes: '', relevant: false };
    this.entries.set(entry.n, entry);
    return entry;
  }

  addFile(name: string): SourceEntry {
    const entry = { n: this.nextN++, file: name, title: name, notes: '', relevant: false };
    this.entries.set(entry.n, entry);
    return entry;
  }

  markRelevant(n: number, notes: string): void {
    const e = this.entries.get(n);
    if (e) { e.relevant = true; if (notes) e.notes = notes.slice(0, 1_500); }
  }

  get(n: number): SourceEntry | undefined { return this.entries.get(n); }
  all(): SourceEntry[] { return [...this.entries.values()].sort((a, b) => a.n - b.n); }
}

export function appendSourcesSection(report: string, sources: SourceEntry[]): { report: string; cited: SourceEntry[] } {
  const body = report.replace(/\n*^##\s+Quellen\b[\s\S]*$/m, '').trimEnd();
  const citedNs = new Set(citedSourcesOf(body));
  const relevant = sources.filter((s) => s.relevant);
  let cited = relevant.filter((s) => citedNs.has(s.n));
  if (cited.length === 0) cited = relevant;
  cited.sort((a, b) => a.n - b.n);
  if (cited.length === 0) return { report: body, cited };
  const lines = cited.map((s) => (s.file
    ? `- [${s.n}] 📎 ${s.file} (eigene Datei)`
    : `- [${s.n}] [${s.title || s.url}](${s.url})`));
  return { report: `${body}\n\n## Quellen\n${lines.join('\n')}`, cited };
}
