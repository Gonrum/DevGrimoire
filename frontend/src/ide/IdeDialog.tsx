import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../components/ui/Button';

/*
 * Modal building block of the IDE (conflict diff, overwrite / close questions).
 * The app-wide `ui/Dialog` is fixed to max-w-lg, too narrow for a side-by-side diff.
 * Fixed class maps instead of assembled class names: Tailwind keeps only literal classes.
 */
const PANEL_CLASS = {
  sm: 'w-full max-w-md',
  fill: 'flex h-[85vh] w-[92vw] max-w-7xl flex-col',
} as const;

const BODY_CLASS = {
  sm: 'px-4 py-3',
  fill: 'flex min-h-0 flex-1 flex-col',
} as const;

interface IdeDialogProps {
  title: string;
  onClose: () => void;
  size?: keyof typeof PANEL_CLASS;
  footer?: ReactNode;
  children: ReactNode;
}

export function IdeDialog({ title, onClose, size = 'sm', footer, children }: IdeDialogProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-2xl ${PANEL_CLASS[size]}`}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-700 bg-gray-800 px-4 py-2.5">
          <span className="truncate text-sm font-medium text-gray-200">{title}</span>
          <button onClick={onClose} aria-label={t('ide.close')} title={t('ide.close')} className="text-lg leading-none text-gray-500 hover:text-gray-300">
            &times;
          </button>
        </div>
        <div className={BODY_CLASS[size]}>{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-gray-700 px-4 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

export interface IdeDialogAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}

interface IdeConfirmDialogProps {
  title: string;
  message: string;
  cancelLabel: string;
  actions: IdeDialogAction[];
  onCancel: () => void;
}

/** A question with a cancel button and one or more answers. */
export function IdeConfirmDialog({ title, message, cancelLabel, actions, onCancel }: IdeConfirmDialogProps) {
  return (
    <IdeDialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} autoFocus>
            {cancelLabel}
          </Button>
          {actions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant ?? 'secondary'}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </>
      }
    >
      <p className="whitespace-pre-wrap wrap-break-word text-sm text-gray-300">{message}</p>
    </IdeDialog>
  );
}
