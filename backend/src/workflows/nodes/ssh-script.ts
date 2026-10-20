/**
 * Mehrzeilige `ssh.exec`-Befehle: jede Zeile läuft in **derselben** Shell
 * (ein `cd` oder `export` wirkt auf die folgenden Zeilen), wird aber einzeln
 * ausgewertet. Dafür schreibt das Skript vor und nach jeder Zeile einen
 * Marker auf stdout **und** stderr; `parseScriptOutput` ordnet die Ausgabe
 * danach den Zeilen zu und entfernt die Marker wieder.
 *
 * Die Marker tragen eine Nonce pro Ausführung: eine Zeile, die etwas
 * Marker-Ähnliches ausgibt, kann die Zuordnung nicht verschieben.
 */

export interface ScriptLine {
  /** 1-basierte physische Startzeile im Befehlsfeld. */
  line: number;
  command: string;
}

export type ScriptAbort = 'timeout' | 'idle_timeout' | 'cancelled';

export interface LineResult {
  line: number;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  aborted?: ScriptAbort;
}

export interface ScriptOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  aborted?: ScriptAbort;
}

/** Ungerade Zahl abschließender Backslashes = Zeilenfortsetzung; `\\` ist ein literaler Backslash. */
function continues(text: string): boolean {
  const trailing = /\\+$/.exec(text);
  return trailing !== null && trailing[0].length % 2 === 1;
}

/**
 * Zerlegt das Befehlsfeld in logische Zeilen. `\` am Zeilenende verbindet mit
 * der Folgezeile (deren führende Leerzeichen entfallen, dazwischen steht genau
 * ein Leerzeichen). Leere und mit `#` beginnende Zeilen entfallen — ein
 * Kommentar setzt sich wie in der Shell auch mit `\` nicht fort. Ein `\` am
 * Ende der letzten Zeile wird verworfen: es verbände sonst mit der Marker-Zeile.
 */
export function splitCommandLines(command: string): ScriptLine[] {
  const physical = command.split(/\r?\n/);
  const result: ScriptLine[] = [];
  let i = 0;
  while (i < physical.length) {
    const start = i;
    let current = physical[i];
    i += 1;
    const trimmed = current.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    while (continues(current)) {
      current = current.slice(0, -1);
      if (i >= physical.length) break;
      const next = physical[i].replace(/^\s+/, '');
      i += 1;
      if (next !== '' && !/\s$/.test(current)) current += ' ';
      current += next;
    }
    const text = current.trim();
    if (text !== '') result.push({ line: start + 1, command: text });
  }
  return result;
}

function assertNonce(nonce: string): void {
  // Die Nonce steht ungequotet im printf-Format und im Parse-RegExp.
  if (!/^[0-9a-f]+$/.test(nonce)) throw new Error('ssh-script: Nonce muss hexadezimal sein');
}

const NOW = '$(date +%s%3N 2>/dev/null)';

/**
 * Baut das Skript: eine Shell, **keine** Subshell pro Zeile. Pro Zeile `i`
 * (0-basiert) davor `__DG_<nonce>_<i>_S_<ms>`, danach `__DG_<nonce>_<i>_E_<rc>_<ms>`,
 * jeweils mit Zeilenumbruch davor und danach auf beide Kanäle. Mit `failFast`
 * endet die Shell nach der ersten Zeile ≠ 0 mit deren Exit-Code. Am Ende
 * steht der Exit-Code der letzten Zeile als Prozess-Exit-Code — sonst wäre er
 * immer der des letzten `printf` (0), auch im SSH-Audit.
 */
export function buildScript(lines: ScriptLine[], opts: { nonce: string; failFast: boolean }): string {
  assertNonce(opts.nonce);
  const parts: string[] = [];
  lines.forEach((l, i) => {
    const start = `'\\n__DG_${opts.nonce}_${i}_S_%s\\n' "$__dg_t"`;
    const end = `'\\n__DG_${opts.nonce}_${i}_E_%s_%s\\n' "$__dg_rc" "$__dg_t"`;
    parts.push(`__dg_t=${NOW}; printf ${start}; printf ${start} >&2`);
    parts.push(l.command);
    parts.push(`__dg_rc=$?; __dg_t=${NOW}; printf ${end}; printf ${end} >&2`);
    if (opts.failFast) parts.push('[ "$__dg_rc" -eq 0 ] || exit "$__dg_rc"');
  });
  if (lines.length > 0) parts.push('exit "$__dg_rc"');
  return parts.join('\n');
}

interface LineState {
  started: boolean;
  ended: boolean;
  exitCode: number | null;
  startMs?: string;
  endMs?: string;
  stdout: string;
  stderr: string;
}

function durationOf(s: LineState): number | null {
  if (s.startMs === undefined || s.endMs === undefined) return null;
  if (!/^\d+$/.test(s.startMs) || !/^\d+$/.test(s.endMs)) return null;
  const d = Number(s.endMs) - Number(s.startMs);
  return Number.isSafeInteger(d) && d >= 0 ? d : null;
}

/**
 * Ordnet die Ausgabe den Zeilen zu. Text zwischen Start- und End-Marker
 * gehört zur Zeile; Text außerhalb (Login-Banner, `cd`-Fehler davor) bleibt
 * nur im bereinigten Gesamttext. Eine gestartete, aber nie beendete Zeile ist
 * die, an der die Shell stand, als sie endete: sie bekommt Exit-Code und
 * Abbruchgrund des Prozesses. Nie gestartete Zeilen erscheinen nicht.
 */
export function parseScriptOutput(
  lines: ScriptLine[],
  out: ScriptOutput,
  nonce: string,
): { lines: LineResult[]; stdout: string; stderr: string; lastExitCode: number | null } {
  assertNonce(nonce);
  const states: LineState[] = lines.map(() => ({
    started: false,
    ended: false,
    exitCode: null,
    stdout: '',
    stderr: '',
  }));

  const scan = (stream: string, channel: 'stdout' | 'stderr'): string => {
    const marker = new RegExp(`\\n__DG_${nonce}_(\\d+)_(?:S_([^\\n]*)|E_(\\d+)_([^\\n]*))\\n`, 'g');
    let cleaned = '';
    let last = 0;
    let open: LineState | undefined;
    for (const m of stream.matchAll(marker)) {
      const state = states[Number(m[1])];
      // Index außerhalb des Skripts kann nur eine Fälschung mit erratener
      // Nonce sein — als gewöhnliche Ausgabe behandeln.
      if (state === undefined) continue;
      const text = stream.slice(last, m.index);
      cleaned += text;
      if (open) open[channel] += text;
      last = m.index + m[0].length;
      if (m[3] === undefined) {
        state.started = true;
        state.startMs ??= m[2];
        open = state;
      } else {
        state.ended = true;
        state.exitCode = Number(m[3]);
        state.endMs ??= m[4];
        open = undefined;
      }
    }
    const tail = stream.slice(last);
    cleaned += tail;
    if (open) open[channel] += tail;
    return cleaned;
  };

  const stdout = scan(out.stdout, 'stdout');
  const stderr = scan(out.stderr, 'stderr');

  const results: LineResult[] = [];
  states.forEach((s, i) => {
    if (!s.started) return;
    const base = { line: lines[i].line, command: lines[i].command, stdout: s.stdout, stderr: s.stderr };
    if (s.ended) {
      results.push({ ...base, exitCode: s.exitCode, durationMs: durationOf(s) });
    } else {
      results.push({
        ...base,
        exitCode: out.exitCode,
        durationMs: null,
        ...(out.aborted ? { aborted: out.aborted } : {}),
      });
    }
  });
  const lastExitCode = results.length > 0 ? results[results.length - 1].exitCode : out.exitCode;
  return { lines: results, stdout, stderr, lastExitCode };
}

/** Grenzen in Sekunden, wie sie im Formular stehen (ms / 1000). */
function seconds(ms: number): string {
  return String(ms / 1000);
}

/** Lesbarer Grund, warum eine Zeile den Node scheitern ließ. */
export function lineFailureMessage(r: LineResult, limits: { timeoutMs: number; idleTimeoutMs: number }): string {
  if (r.aborted === 'idle_timeout') {
    return `Zeile ${r.line} abgebrochen: ${seconds(limits.idleTimeoutMs)} s ohne Ausgabe`;
  }
  if (r.aborted === 'timeout') {
    return `Zeile ${r.line} abgebrochen: Zeitlimit ${seconds(limits.timeoutMs)} s erreicht`;
  }
  if (r.aborted === 'cancelled') return `Zeile ${r.line} abgebrochen`;
  if (r.exitCode === null) return `Zeile ${r.line} endete ohne Exit-Code (Signal)`;
  return `Zeile ${r.line} endete mit Exit-Code ${r.exitCode}`;
}
