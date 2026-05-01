import { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useState } from 'react';

const inputBase = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500';
const inputError = 'border-red-700 focus:border-red-500';

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs text-gray-500 mb-1">
      {children}{required && ' *'}
    </label>
  );
}

function FieldHelper({ error, helpText }: { error?: ReactNode; helpText?: ReactNode }) {
  if (error) return <p className="mt-1 text-xs text-red-400">{error}</p>;
  if (helpText) return <p className="mt-1 text-xs text-gray-500">{helpText}</p>;
  return null;
}

interface CommonFieldProps {
  label?: string;
  required?: boolean;
  fieldClassName?: string;
  helpText?: ReactNode;
  error?: ReactNode;
}

interface FormInputProps extends InputHTMLAttributes<HTMLInputElement>, CommonFieldProps {}

export function FormInput({ label, required, fieldClassName = '', className = '', helpText, error, ...props }: FormInputProps) {
  return (
    <div className={fieldClassName}>
      {label && <Label required={required}>{label}</Label>}
      <input className={`${inputBase} ${error ? inputError : ''} ${className}`} {...props} />
      <FieldHelper error={error} helpText={helpText} />
    </div>
  );
}

interface FormSelectProps extends SelectHTMLAttributes<HTMLSelectElement>, CommonFieldProps {}

export function FormSelect({ label, required, fieldClassName = '', className = '', children, helpText, error, ...props }: FormSelectProps) {
  return (
    <div className={fieldClassName}>
      {label && <Label required={required}>{label}</Label>}
      <select className={`${inputBase} ${error ? inputError : ''} ${className}`} {...props}>
        {children}
      </select>
      <FieldHelper error={error} helpText={helpText} />
    </div>
  );
}

interface FormTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, CommonFieldProps {}

export function FormTextarea({ label, required, fieldClassName = '', className = '', helpText, error, ...props }: FormTextareaProps) {
  return (
    <div className={fieldClassName}>
      {label && <Label required={required}>{label}</Label>}
      <textarea className={`${inputBase} resize-none ${error ? inputError : ''} ${className}`} {...props} />
      <FieldHelper error={error} helpText={helpText} />
    </div>
  );
}

interface SecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>, CommonFieldProps {
  storedHint?: ReactNode;
  toggleAriaLabel?: string;
}

export function SecretInput({
  label,
  required,
  fieldClassName = '',
  className = '',
  helpText,
  error,
  storedHint,
  toggleAriaLabel = 'Toggle visibility',
  ...props
}: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={fieldClassName}>
      {label && <Label required={required}>{label}</Label>}
      <div className="flex items-stretch gap-2">
        <input
          type={visible ? 'text' : 'password'}
          className={`${inputBase} flex-1 ${error ? inputError : ''} ${className}`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={toggleAriaLabel}
          className="rounded border border-gray-700 bg-gray-800 px-3 text-xs text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
        >
          {visible ? '🙈' : '👁'}
        </button>
      </div>
      {storedHint && <p className="mt-1 text-xs text-amber-400">{storedHint}</p>}
      <FieldHelper error={error} helpText={helpText} />
    </div>
  );
}
