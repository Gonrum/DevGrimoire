/**
 * Der Toast-Kontext und sein Hook.
 *
 * Die Komponente (`ToastProvider`) liegt bewusst daneben in `ToastProvider.tsx`:
 * `react-refresh/only-export-components` verlangt, dass eine Datei mit einer
 * Komponente **nur** Komponenten exportiert — sonst verliert Fast Refresh für
 * jede der 67 Dateien, die `useToast` importieren, den State beim Speichern.
 *
 * Diese Datei behält den Namen `Toast`, damit die 67 Importe
 * `from '.../Toast'` unverändert weiterlaufen; sie ist jetzt `.ts` statt `.tsx`,
 * weil sie kein JSX mehr enthält.
 */
import { createContext, useContext } from 'react';

export interface ToastItem {
  id: number;
  message: string;
  type: 'error' | 'success';
}

export interface ToastContextType {
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
}

export const ToastContext = createContext<ToastContextType>({
  showError: () => {},
  showSuccess: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}
