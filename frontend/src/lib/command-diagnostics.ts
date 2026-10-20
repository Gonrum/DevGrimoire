/**
 * Diagnosen für den Shell-Editor des ssh.exec-Befehls.
 * Bewusst importfrei, damit `scripts/command-diagnostics-check.cjs` die Datei
 * ohne Bundler übersetzen kann — daher ist `PlaceholderTrace` hier als
 * Teilmenge dupliziert (siehe placeholder-view.ts).
 */

interface PlaceholderTrace {
  field: string;
  line: number;
  expr: string;
  status: string;
}

export interface CommandDiagnostic {
  /** 1-basierte Zeile. */
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Liegt der Platzhalter bei `index` innerhalb von '…' oder "…"? Der Zustand
 * wird von Zeilenanfang an mitgeführt; ein Backslash maskiert in "…" das
 * nächste Zeichen, in '…' gibt es keine Maskierung (wie in der Shell).
 * Platzhalter selbst werden übersprungen, damit ein Anführungszeichen im
 * Platzhaltertext den Zustand nicht kippt.
 */
function quotedPlaceholderInLine(line: string): boolean {
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (line.startsWith('{{', i)) {
      const raw = line.startsWith('{{{', i);
      const close = line.indexOf(raw ? '}}}' : '}}', i + (raw ? 3 : 2));
      if (close === -1) return false;
      if (quote !== null) return true;
      i = close + (raw ? 3 : 2);
      continue;
    }
    if (quote === null) {
      if (ch === '\\') i += 1;
      else if (ch === '"' || ch === "'") quote = ch;
    } else if (ch === quote) {
      quote = null;
    } else if (quote === '"' && ch === '\\') {
      i += 1;
    }
    i += 1;
  }
  return false;
}

export function commandDiagnostics(command: string, placeholders: PlaceholderTrace[]): CommandDiagnostic[] {
  const lines = command.split('\n');
  const clamp = (line: number) => Math.min(Math.max(1, Math.trunc(line)), lines.length);
  const out: CommandDiagnostic[] = [];

  for (const trace of placeholders) {
    if (trace.field !== 'command') continue;
    if (trace.status === 'missing') {
      out.push({ line: clamp(trace.line), severity: 'error', message: `Platzhalter nicht auflösbar: ${trace.expr}` });
    } else if (trace.status === 'secret_forbidden') {
      out.push({ line: clamp(trace.line), severity: 'error', message: `Secret nicht erlaubt: ${trace.expr}` });
    } else if (trace.status === 'unknown') {
      out.push({ line: clamp(trace.line), severity: 'warning', message: 'Wert erst nach Trockenlauf bekannt' });
    }
  }

  lines.forEach((text, idx) => {
    if (quotedPlaceholderInLine(text)) {
      out.push({ line: idx + 1, severity: 'error', message: 'Platzhalter nicht in Anführungszeichen setzen' });
    }
  });
  return out;
}
