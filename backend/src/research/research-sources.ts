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

const MAX_RANGE = 20;
/** `[n]`, `[n, m]`, `[n; m]`, `[n-m]`, `[^n]`; `[` direkt nach einem Wortzeichen (`a[1]`) zählt nicht. */
const CITE_RE = /([ \t]?)(?<!\w)\[(\^?)(\d+(?:\s*[-–]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–]\s*\d+)?)*)\]/g;

function numbersOfBracket(inner: string): number[] {
  const out: number[] = [];
  for (const part of inner.split(/[,;]/)) {
    const range = /^\s*(\d+)\s*[-–]\s*(\d+)\s*$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let k = from; k <= to && k - from < MAX_RANGE && out.length < MAX_RANGE; k++) out.push(k);
    } else {
      out.push(Number(part.trim()));
    }
  }
  return out.filter((n) => Number.isInteger(n) && n >= 1);
}

export function citedSourcesOf(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(CITE_RE)) {
    for (const n of numbersOfBracket(m[3])) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Entfernt Zitate auf Nummern, die es nicht gibt (bei Mehrfach-Klammern nur diese Nummern). */
function dropUnknownCitations(text: string, known: Set<number>): string {
  return text.replace(CITE_RE, (whole: string, space: string, caret: string, inner: string) => {
    const nums = numbersOfBracket(inner);
    const keep = nums.filter((n) => known.has(n));
    if (keep.length === nums.length) return whole;
    if (keep.length === 0) return '';
    return `${space}[${caret}${keep.join(', ')}]`;
  });
}

const SOURCE_HEADING = /^#{2,3}\s+(?:quellen|quellenverzeichnis|literatur|sources|references):?\s*$/i;
const SOURCE_TAIL_LINE = /^\s*$|^\s*(?:[-*]|\d+\.)\s|^\s*\[[^\]]+\]:\s|^\s*\[[^\]]+\]\([^)]*\)\s*$/;

/** Entfernt nur einen ABSCHLIESSENDEN Quellenabschnitt (Überschrift + nur Listen-/Linkzeilen bis zum Ende). */
function stripTrailingSources(report: string): string {
  const lines = report.split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SOURCE_HEADING.test(lines[i])) { idx = i; break; }
  }
  if (idx < 0) return report;
  if (!lines.slice(idx + 1).every((l) => SOURCE_TAIL_LINE.test(l))) return report;
  return lines.slice(0, idx).join('\n');
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
  const known = new Set(sources.map((s) => s.n));
  const body = dropUnknownCitations(stripTrailingSources(report), known).trimEnd();
  const citedNs = new Set(citedSourcesOf(body));
  let cited = sources.filter((s) => citedNs.has(s.n));
  for (const s of cited) s.relevant = true;
  if (cited.length === 0) cited = sources.filter((s) => s.relevant);
  cited.sort((a, b) => a.n - b.n);
  if (cited.length === 0) return { report: body, cited };
  const lines = cited.map((s) => (s.file
    ? `- [${s.n}] 📎 ${s.file} (eigene Datei)`
    : `- [${s.n}] [${s.title || s.url}](${s.url})`));
  return { report: `${body}\n\n## Quellen\n${lines.join('\n')}`, cited };
}
