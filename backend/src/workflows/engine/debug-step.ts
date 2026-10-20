import type { WorkflowNodeRisk } from '../workflow-security.policy';
import type { NodeMetadata } from './node-metadata';

/**
 * Reine Logik des Debug-Laufs: ein Lauf mit `mode: 'debug'` hält vor jedem
 * Node an. Statt Nachfolger einzureihen, merkt er sie sich in
 * `debug.pendingNodeIds`; jeder Schritt kommt einzeln per REST.
 */

/** Ein Debug-Lauf, der so lange nicht weitergeschaltet wurde, wird abgebrochen. */
export const DEBUG_IDLE_MS = 30 * 60_000;

/** Wartende Nodes, die im Debug nicht abgewartet werden — echt wie trocken. */
export const DEBUG_SKIP_TYPES: readonly string[] = ['control.delay', 'delay.wait'];

/**
 * Ausgabe eines trocken gelaufenen Nodes: `dryRun: true` und je Schlüssel aus
 * den `outputs`-Metadaten `null`. Der Platzhalter-Resolver liest Pfade
 * darunter als „aufgelöst, Wert unbekannt" — sonst bräche jeder Trockenlauf
 * beim nächsten Node mit `template_unresolved` ab.
 */
export function dryPlaceholder(outputs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { dryRun: true };
  for (const key of Object.keys(outputs)) out[key] = null;
  return out;
}

/**
 * Wartende Nodes nach einem Schritt: ohne den gelaufenen Node, ohne die
 * Nachfolger seines vorigen Laufs (eine Wiederholung ersetzt sie), plus die
 * neuen Nachfolger. Reihenfolge stabil, jede Id einmal — die erste Id ist der
 * nächste Schritt.
 */
export function nextPending(
  pending: string[],
  stepped: string,
  successors: string[],
  previousSuccessors: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  const replaced = new Set(previousSuccessors);
  for (const id of pending) if (id !== stepped && !replaced.has(id)) add(id);
  for (const id of successors) add(id);
  return out;
}

/** Wartende Nodes, die im aktuellen Editor-Graphen nicht mehr vorkommen. */
export function dropMissing(pending: string[], nodeIds: string[]): { pending: string[]; dropped: string[] } {
  const present = new Set(nodeIds);
  return {
    pending: pending.filter((id) => present.has(id)),
    dropped: pending.filter((id) => !present.has(id)),
  };
}

export type DryStrategy = 'execute' | 'skip_delay' | 'ssh_preview' | 'agent_dry' | 'placeholder';

/**
 * Wie ein Schritt läuft. Delays werden immer übersprungen. Ein echter Schritt
 * führt aus. Im Trockenlauf laufen reine Lese-/Steuer-Nodes trotzdem echt —
 * sie verändern nichts, und ohne ihre Ausgabe sähen die Folge-Nodes nichts.
 * `ssh.exec` prüft nur die Verbindung und zeigt die Befehle, `agent.task`
 * läuft mit Read-only-Tools, alles andere liefert nur Platzhalter.
 */
export function dryStrategy(
  type: string,
  risk: WorkflowNodeRisk,
  category: NodeMetadata['category'],
  dry: boolean,
): DryStrategy {
  if (DEBUG_SKIP_TYPES.includes(type)) return 'skip_delay';
  if (!dry) return 'execute';
  if (risk === 'safe-read') return 'execute';
  if (type === 'ssh.exec') return 'ssh_preview';
  if (category === 'agent') return 'agent_dry';
  return 'placeholder';
}

/**
 * Kopie ohne `undefined`-Felder für den Snapshot im Lauf: DTO-Knoten tragen
 * optionale Felder als `undefined`, die der Treiber in `Mixed`-Pfaden als
 * `null` speichern würde.
 */
export function withoutUndefined(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
