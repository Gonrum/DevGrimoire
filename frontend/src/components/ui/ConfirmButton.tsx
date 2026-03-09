import { useState, useEffect, useRef } from 'react';
import Button from './Button';

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
  label = 'Löschen',
  confirmLabel = 'Sicher?',
  variant = 'secondary',
  confirmVariant = 'danger-solid',
  size = 'xs',
  className = '',
  disabled,
  timeout = 3000,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const mountedRef = useRef(true);

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
      onClick={handleClick}
      onBlur={() => setConfirming(false)}
      className={className}
      disabled={disabled}
    >
      {confirming ? confirmLabel : label}
    </Button>
  );
}
