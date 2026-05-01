import { Link, LinkProps } from 'react-router-dom';

const variants = {
  primary: 'bg-violet-600 hover:bg-violet-500 text-white',
  secondary: 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200',
} as const;

const sizes = {
  xs: 'text-xs px-2.5 py-1 sm:px-2 sm:py-0.5',
  sm: 'text-xs px-3 py-1.5 sm:px-2.5 sm:py-1',
  md: 'px-3.5 py-2 sm:px-3 sm:py-1.5 text-sm',
  lg: 'px-4 py-2.5 sm:px-4 sm:py-2 text-sm',
} as const;

interface ButtonLinkProps extends LinkProps {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export default function ButtonLink({ variant = 'secondary', size = 'sm', className = '', ...props }: ButtonLinkProps) {
  return (
    <Link
      className={`inline-flex items-center rounded-lg transition-colors ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
