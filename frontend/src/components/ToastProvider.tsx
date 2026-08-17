import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ToastContext, ToastItem } from './Toast';

/**
 * Rendert die Toast-Liste und stellt `showError`/`showSuccess` bereit.
 *
 * Kontext und Hook liegen in `Toast.ts` — Begründung dort.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  // Offene Timer, damit ein Unmount sie abräumt statt in ein setState auf einer
  // abgebauten Komponente zu laufen.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    },
    [],
  );

  const addToast = useCallback((message: string, type: 'error' | 'success') => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current = timersRef.current.filter((t) => t !== timer);
    }, 4000);
    timersRef.current.push(timer);
  }, []);

  const showError = useCallback((message: string) => addToast(message, 'error'), [addToast]);
  const showSuccess = useCallback((message: string) => addToast(message, 'success'), [addToast]);

  /*
   * Der Kontextwert muss stabil sein (M-52).
   *
   * Vorher stand hier `value={{ showError, showSuccess }}` — ein bei jedem
   * Provider-Render neues Objekt. Damit ist das Ergebnis von `useToast()` als
   * Hook-Dependency unbrauchbar, und genau das braucht man beim Auflösen von
   * `exhaustive-deps`: ein Lade-Effect, der `showError` in seinen Deps führt,
   * würde endlos laufen — Fehler → Toast → Provider-Render → neuer
   * Kontextwert → erneutes Laden. Ein Agent musste deshalb bereits auf ein Ref
   * ausweichen.
   *
   * `showError`/`showSuccess` sind schon `useCallback`-stabil; nur die Hülle
   * fehlte.
   */
  const value = useMemo(() => ({ showError, showSuccess }), [showError, showSuccess]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 left-4 right-4 sm:left-auto z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-2.5 rounded-lg text-sm shadow-lg sm:max-w-sm animate-[fadeIn_0.2s_ease-out] ${
              toast.type === 'error'
                ? 'bg-red-900/90 border border-red-700 text-red-200'
                : 'bg-green-900/90 border border-green-700 text-green-200'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
