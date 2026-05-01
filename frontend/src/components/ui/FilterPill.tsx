import { ButtonHTMLAttributes, ReactNode } from 'react';

const tones = {
  violet: 'bg-violet-600 text-white',
  purple: 'bg-purple-600 text-white',
  cyan: 'bg-cyan-600 text-white',
} as const;

interface FilterPillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  active?: boolean;
  count?: number;
  tone?: keyof typeof tones;
  children: ReactNode;
}

export default function FilterPill({
  active = false,
  count,
  tone = 'violet',
  className = '',
  children,
  ...props
}: FilterPillProps) {
  const inactive = 'bg-gray-800 text-gray-400 hover:text-gray-200';
  return (
    <button
      type="button"
      className={`text-xs px-2.5 py-1 rounded-full transition-colors ${active ? tones[tone] : inactive} ${className}`}
      {...props}
    >
      {children}
      {typeof count === 'number' && <span className="ml-1 opacity-80">({count})</span>}
    </button>
  );
}
