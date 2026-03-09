import { ButtonHTMLAttributes, forwardRef } from 'react';

const variants = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white',
  secondary: 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200',
  danger: 'bg-red-900/40 hover:bg-red-900/60 text-red-400',
  'danger-solid': 'bg-red-700 hover:bg-red-600 text-white',
  ghost: 'text-gray-500 hover:text-gray-300',
  'ghost-blue': 'text-blue-400 hover:text-blue-300',
  none: '',
} as const;

const sizes = {
  xs: 'text-xs px-2 py-0.5',
  sm: 'text-xs px-2.5 py-1',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-sm',
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
