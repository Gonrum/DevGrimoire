import { ButtonHTMLAttributes, forwardRef } from 'react';

const variants = {
  primary: 'bg-violet-600 hover:bg-violet-500 text-white',
  secondary: 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200',
  neutral: 'bg-gray-700 hover:bg-gray-600 text-gray-300',
  success: 'bg-green-900/60 hover:bg-green-900 text-green-300',
  warning: 'bg-yellow-900/60 hover:bg-yellow-900 text-yellow-300',
  info: 'bg-purple-900/60 hover:bg-purple-900 text-purple-300',
  edit: 'bg-violet-900/60 hover:bg-violet-900 text-cyan-300',
  accent: 'bg-violet-900/60 hover:bg-violet-900 text-violet-300',
  danger: 'bg-red-900/40 hover:bg-red-900/60 text-red-400',
  'danger-solid': 'bg-red-700 hover:bg-red-600 text-white',
  ghost: 'text-gray-500 hover:text-gray-300',
  'ghost-blue': 'text-cyan-400 hover:text-cyan-300',
  none: '',
} as const;

const sizes = {
  xs: 'text-xs px-2.5 py-1 sm:px-2 sm:py-0.5',
  sm: 'text-xs px-3 py-1.5 sm:px-2.5 sm:py-1',
  md: 'px-3.5 py-2 sm:px-3 sm:py-1.5 text-sm',
  lg: 'px-4 py-2.5 sm:px-4 sm:py-2 text-sm',
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', className = '', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`rounded transition-colors disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      />
    );
  },
);

Button.displayName = 'Button';

export default Button;
