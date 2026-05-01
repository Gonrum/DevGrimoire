import { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const inputBase = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500';

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs text-gray-500 mb-1">
      {children}{required && ' *'}
    </label>
  );
}

interface FormInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  required?: boolean;
  fieldClassName?: string;
}

export function FormInput({ label, required, fieldClassName = '', className = '', ...props }: FormInputProps) {
  return (
    <div className={fieldClassName}>
      {label && <Label required={required}>{label}</Label>}
      <input className={`${inputBase} ${className}`} {...props} />
    </div>
  );
}

interface FormSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  required?: boolean;
  fieldClassName?: string;
}

export function FormSelect({ label, required, fieldClassName = '', className = '', children, ...props }: FormSelectProps) {
  return (
    <div className={fieldClassName}>
      {label && <Label required={required}>{label}</Label>}
      <select className={`${inputBase} ${className}`} {...props}>
        {children}
      </select>
    </div>
  );
}

interface FormTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  required?: boolean;
  fieldClassName?: string;
}

export function FormTextarea({ label, required, fieldClassName = '', className = '', ...props }: FormTextareaProps) {
  return (
    <div className={fieldClassName}>
      {label && <Label required={required}>{label}</Label>}
      <textarea className={`${inputBase} resize-none ${className}`} {...props} />
    </div>
  );
}
