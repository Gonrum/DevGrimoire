import { createContext, useContext } from 'react';

/**
 * Aktionen der Toolbar-Buttons an Nodes und Edges. Vorher steckten sie als
 * Funktionen in `node.data`/`edge.data` und wurden per Effect injiziert — der
 * lief aber vor dem Laden des Workflows, geladene Nodes hatten also keine
 * Handler und Stift/Duplizieren/Löschen in der Toolbar taten nichts (T-503).
 */
export interface WorkflowCanvasActions {
  onEditNode: (id: string) => void;
  onDuplicateNode: (id: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}

const noop = () => { /* kein Editor-Kontext, z.B. in einer Vorschau */ };

export const WorkflowCanvasActionsContext = createContext<WorkflowCanvasActions>({
  onEditNode: noop,
  onDuplicateNode: noop,
  onDeleteNode: noop,
  onDeleteEdge: noop,
});

export function useWorkflowCanvasActions(): WorkflowCanvasActions {
  return useContext(WorkflowCanvasActionsContext);
}
