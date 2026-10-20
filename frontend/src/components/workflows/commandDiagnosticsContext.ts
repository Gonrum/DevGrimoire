import { createContext, useContext } from 'react';
import type { PlaceholderTrace } from '../../lib/placeholder-view';

/**
 * Platzhalter-Spuren der Eingesetzt-Vorschau für den Shell-Editor. Das Modal
 * stellt sie bereit; im Seitenpanel (ohne Vorschau) bleibt die Liste leer und
 * der Editor zeigt nur die Anführungszeichen-Regel. Ein Kontext statt Props,
 * weil die Spuren sonst durch NodeConfigForm und alle Akkordeons wandern müssten.
 */
export const CommandDiagnosticsContext = createContext<PlaceholderTrace[]>([]);

export function useCommandPlaceholders(): PlaceholderTrace[] {
  return useContext(CommandDiagnosticsContext);
}
