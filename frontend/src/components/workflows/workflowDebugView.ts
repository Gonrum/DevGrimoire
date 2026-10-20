import { createContext, useContext } from 'react';
import type { NodeDebugState } from '../../lib/debug-view';

/**
 * Debug-Zustand der Nodes für das Canvas. Über einen Kontext statt über
 * `node.data`: jede Live-Aktualisierung des Laufs würde sonst alle Nodes neu
 * schreiben — und `nodes` ist zugleich, was Autosave und Speichern-DTO lesen.
 * `null` = kein Debug-Lauf, die Nodes zeigen ihr `data.runStatus` wie bisher.
 */
export interface WorkflowDebugView {
  states: Record<string, NodeDebugState>;
  /** Node, auf den sich Schritt-Knöpfe und Panel beziehen. */
  markedNodeId: string | null;
}

export const WorkflowDebugViewContext = createContext<WorkflowDebugView | null>(null);

export function useWorkflowDebugView(): WorkflowDebugView | null {
  return useContext(WorkflowDebugViewContext);
}
