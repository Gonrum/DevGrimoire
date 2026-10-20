/**
 * Debug-Modus im Workflow-Editor: reine Ableitungen aus Lauf und NodeRuns.
 * Bewusst importfrei, damit `scripts/debug-view-check.cjs` die Datei ohne
 * Bundler nach CommonJS übersetzen und prüfen kann.
 */

export interface NodeDebugState { status: string; dry: boolean; current: boolean; dimmed: boolean }

interface NodeRunLike { nodeId: string; status: string; dryRun?: boolean; attempt: number }

/** Jüngster NodeRun eines Nodes (höchster `attempt`) — ein wiederholter Schritt ersetzt den alten. */
export function latestNodeRun<T extends NodeRunLike>(nodeRuns: T[], nodeId: string | null): T | undefined {
  if (nodeId === null) return undefined;
  let best: T | undefined;
  for (const nr of nodeRuns) {
    if (nr.nodeId !== nodeId) continue;
    if (!best || nr.attempt > best.attempt) best = nr;
  }
  return best;
}

/**
 * Zustand je Node des Editors: Status und Trocken-Markierung des jüngsten
 * NodeRuns, ohne NodeRun `idle`. Aktuell ist nur der erste wartende Node —
 * der Debug-Lauf schaltet mehrere Nachfolger nacheinander weiter.
 * NodeRuns gelöschter Nodes fallen heraus: das Canvas zeigt nur, was es gibt.
 * Ist der Lauf zu Ende (auch abgebrochen), wartet nichts mehr: kein gelber
 * Ring, nichts gedimmt — die liegengebliebene `pendingNodeIds` zählt nicht.
 */
export function nodeDebugStates(
  nodeIds: string[],
  nodeRuns: NodeRunLike[],
  pending: string[],
  runStatus?: string,
): Record<string, NodeDebugState> {
  const ended = isTerminalRunStatus(runStatus);
  const active = activePending(runStatus, pending);
  const current = active.length > 0 ? active[0] : null;
  const out: Record<string, NodeDebugState> = {};
  for (const id of nodeIds) {
    const latest = latestNodeRun(nodeRuns, id);
    const status = latest ? latest.status : 'idle';
    out[id] = {
      status,
      dry: latest?.dryRun === true,
      current: id === current,
      // Noch nicht gelaufen und nicht an der Reihe: gedimmt, damit der Weg
      // durch den Graphen sichtbar wird — nur solange der Lauf noch läuft.
      dimmed: !ended && status === 'idle' && id !== current,
    };
  }
  return out;
}

/** Wartende Nodes eines Laufs; nach seinem Ende keine mehr. */
export function activePending(runStatus: string | undefined, pending: string[]): string[] {
  return isTerminalRunStatus(runStatus) ? [] : pending;
}

/** Ein Schritt ist nur möglich, solange der Lauf vor einem Node anhält. */
export function canStep(runStatus: string | undefined): boolean {
  return runStatus === 'waiting_for_step';
}

/** Endzustand eines Laufs — die Debug-Leiste zeigt dann das Ergebnis statt der Schritt-Knöpfe. */
export function isTerminalRunStatus(runStatus: string | undefined): boolean {
  return runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled';
}

/**
 * Eingabe-Feld der Debug-Leiste: leer heißt `{}`, sonst muss es ein
 * JSON-Objekt sein. `null` = ungültig, Start bleibt gesperrt.
 */
export function parseDebugInput(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

/**
 * Prüfungsfehler eines 400 als Liste. Der Server liefert sie entweder als
 * Array (an der HTTP-Grenze mit „; " verbunden) oder schon als „a; b"-Text.
 */
export function issueLines(message: string): string[] {
  return message.split(/;\s*/).map((line) => line.trim()).filter((line) => line.length > 0);
}
