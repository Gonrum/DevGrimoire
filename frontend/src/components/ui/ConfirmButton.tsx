import { useState, useEffect, useRef } from 'react';
import i18n from '../../i18n';
import Button from './Button';
import { useToast } from '../Toast';
import { errorMessage } from '../../lib/narrow';

interface ConfirmButtonProps {
  onConfirm: () => void | Promise<void>;
  label?: string;
  confirmLabel?: string;
  variant?: 'secondary' | 'danger' | 'danger-solid';
  confirmVariant?: 'danger' | 'danger-solid';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  disabled?: boolean;
  timeout?: number;
}

export default function ConfirmButton({
  onConfirm,
  label = i18n.t('common.delete'),
  confirmLabel = i18n.t('common.confirmDelete'),
  variant = 'secondary',
  confirmVariant = 'danger-solid',
  size = 'xs',
  className = '',
  disabled,
  timeout = 3000,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const mountedRef = useRef(true);
  const { showError } = useToast();

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => {
      if (mountedRef.current) setConfirming(false);
    }, timeout);
    return () => clearTimeout(timer);
  }, [confirming, timeout]);

  const handleClick = async () => {
    if (confirming) {
      try {
        await onConfirm();
      } finally {
        if (mountedRef.current) setConfirming(false);
      }
    } else {
      setConfirming(true);
    }
  };

  return (
    <Button
      type="button"
      variant={confirming ? confirmVariant : variant}
      size={size}
      onClick={() => {
        /*
         * `onConfirm` darf ein Promise liefern. Die meisten Aufrufer fangen ihre
         * Fehler selbst und zeigen einen Toast; wer das **nicht** tut, dessen
         * Fehler verschwand hier bisher restlos — der Nutzer sah nur, dass der
         * Button zurückspringt. Deshalb der Toast als Auffangnetz: er feuert nur,
         * wenn `onConfirm` wirklich abgelehnt hat, also nie doppelt.
         */
        handleClick().catch((err: unknown) => {
          showError(errorMessage(err));
        });
      }}
      onBlur={() => setConfirming(false)}
      className={className}
      disabled={disabled}
    >
      {confirming ? confirmLabel : label}
    </Button>
  );
}
