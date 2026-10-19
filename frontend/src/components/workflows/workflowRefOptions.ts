import { createContext, useContext } from 'react';

/**
 * Auswahllisten für Felder, die auf andere Entitäten verweisen (Schema-
 * Beschreibung `ref:…`). Der Editor lädt sie einmal pro Workflow; die
 * Konfigurationsformulare (Inspector und Modal) lesen sie hier, ohne dass
 * jedes Feld selbst die API anfragt.
 */
export interface WorkflowRefOptions {
  sshConnections: Array<{ id: string; label: string; inherited: boolean }>;
}

/** Ohne Editor-Kontext (z.B. Vorschau) gibt es schlicht keine Optionen. */
export const WorkflowRefOptionsContext = createContext<WorkflowRefOptions>({
  sshConnections: [],
});

export function useWorkflowRefOptions(): WorkflowRefOptions {
  return useContext(WorkflowRefOptionsContext);
}
